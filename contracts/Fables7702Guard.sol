// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import "./libraries/FullMath.sol";
import "./libraries/TickMath.sol";

interface IERC20Guard {
    function balanceOf(address owner) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

interface IFablesWithdrawHook {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function deposit(PoolKey calldata key, int24 tickLower, int24 tickUpper,
        uint128 liquidity, uint128 amount0Max, uint128 amount1Max, uint256 deadline) external;
    function balanceOf(address owner, uint256 rangeId) external view returns (uint256);

    function withdrawAndClaim(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        address recipient,
        uint128 amount0Min,
        uint128 amount1Min,
        uint256 deadline,
        uint16 walk
    ) external;
}

interface IFablesRegistryGuard {
    struct Pool { IFablesWithdrawHook.PoolKey key; bytes32 id; bool active; }
    function activePools() external view returns (Pool[] memory);
}

/// @notice EIP-7702 delegation target for atomic Fables OOR withdrawal.
/// @dev This code is intended to execute at the EOA address through EIP-7702.
///      Direct calls to the implementation cannot withdraw user positions.
contract Fables7702Guard {
    // Public so setup/verification tooling can prove that delegated runtime code
    // is the exact implementation address that was configured and audited.
    // The immutable value is baked into the implementation bytecode at deploy time.
    address public immutable IMPLEMENTATION = address(this);
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    address internal constant ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address internal constant REGISTRY = 0x159A113E012593D9B3cC63ad45E30F0467e13Ef3;
    uint256 internal constant Q96 = 1 << 96;

    struct AtomicDeposit {
        IFablesWithdrawHook.PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint256 expectedBalance0;
        uint256 expectedBalance1;
        uint128 funding0;
        uint128 funding1;
        uint8 tokenIn; // 0/1 for a swap; 2 for deposit only
        bytes32 swapPoolId; // full V4 key hash explicitly signed by the EOA; zero for V3
        uint128 amountIn;
        uint128 minOut;
        uint128 minLiquidity;
        uint16 maxResidualBps;
        uint256 deadline;
        bytes routerData;
    }
    struct V4Swap {
        IFablesWithdrawHook.PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minOut;
        uint256 minHopPrice;
        bytes hookData;
    }

    error DirectImplementationCall();
    error OnlySelfCall();
    error WrongChain(uint256 chainId);
    error InRange(int24 currentTick, int24 tickLower, int24 tickUpper);
    error InvalidRecipient(address recipient);
    error InvalidHook(address hook);
    error ZeroLiquidity();
    error InvalidAtomicPlan();
    error BalanceChanged();
    error SwapDeltaMismatch();
    error ExcessResidual(uint256 residual0, uint256 residual1);
    error ApprovalFailed();
    error LiquidityBelowMinimum();
    error PositionMintMismatch();
    event AtomicDeposited(bytes32 indexed poolId, uint128 liquidity,
        uint128 funding0, uint128 funding1, uint256 residual0, uint256 residual1);

    receive() external payable {}
    fallback() external payable {}

    function guardVersion() external pure returns (bytes32) {
        return keccak256("Fables7702Guard/v2");
    }

    /// @notice One swap and one maximal LP deposit in the same transaction.
    /// @dev Price and available inventory are read after the swap and approvals.
    ///      A stale ratio reverts the whole transaction, including the swap.
    function atomicSwapAndDeposit(AtomicDeposit calldata p) external {
        if (address(this) == IMPLEMENTATION) revert DirectImplementationCall();
        if (msg.sender != address(this)) revert OnlySelfCall();
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (p.key.hooks == address(0) || p.key.currency0 == address(0)
            || p.key.currency0 >= p.key.currency1 || p.key.tickSpacing <= 0
            || p.tickLower >= p.tickUpper || p.tickLower % p.key.tickSpacing != 0
            || p.tickUpper % p.key.tickSpacing != 0 || p.maxResidualBps > 50
            || p.deadline < block.timestamp || p.minLiquidity == 0) revert InvalidAtomicPlan();
        bytes32 poolId = keccak256(abi.encode(p.key));
        IFablesRegistryGuard.Pool[] memory pools = IFablesRegistryGuard(REGISTRY).activePools();
        bool registered;
        for (uint256 i; i < pools.length; i++) {
            if (pools[i].active && pools[i].id == poolId
                && keccak256(abi.encode(pools[i].key)) == poolId) { registered = true; break; }
        }
        if (!registered) revert InvalidHook(p.key.hooks);
        IERC20Guard t0 = IERC20Guard(p.key.currency0);
        IERC20Guard t1 = IERC20Guard(p.key.currency1);
        uint256 b0 = t0.balanceOf(address(this));
        uint256 b1 = t1.balanceOf(address(this));
        if (b0 != p.expectedBalance0 || b1 != p.expectedBalance1
            || p.funding0 > b0 || p.funding1 > b1) revert BalanceChanged();
        uint256 protected0 = b0 - p.funding0;
        uint256 protected1 = b1 - p.funding1;
        if (p.tokenIn < 2) {
            if (p.amountIn == 0 || p.minOut == 0 || p.routerData.length < 4
                || bytes4(p.routerData[:4]) != bytes4(keccak256("execute(bytes,bytes[],uint256)"))
                || p.amountIn > (p.tokenIn == 0 ? p.funding0 : p.funding1)) revert InvalidAtomicPlan();
            _validateRouter(p, pools);
            (bool ok, bytes memory result) = ROUTER.call(p.routerData);
            if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
            uint256 a0 = t0.balanceOf(address(this));
            uint256 a1 = t1.balanceOf(address(this));
            if (p.tokenIn == 0) {
                if (a0 + p.amountIn != b0 || a1 < b1 + p.minOut) revert SwapDeltaMismatch();
            } else {
                if (a1 + p.amountIn != b1 || a0 < b0 + p.minOut) revert SwapDeltaMismatch();
            }
            b0 = a0; b1 = a1;
        } else if (p.tokenIn != 2 || p.routerData.length != 0 || p.amountIn != 0 || p.minOut != 0) {
            revert InvalidAtomicPlan();
        }
        uint256 f0 = b0 - protected0;
        uint256 f1 = b1 - protected1;
        if (f0 > type(uint128).max || f1 > type(uint128).max) revert InvalidAtomicPlan();
        _approve(t0, p.key.hooks, f0);
        _approve(t1, p.key.hooks, f1);
        (uint160 price, int24 tick,,) = IStateView(STATE_VIEW).getSlot0(poolId);
        if (tick < p.tickLower || tick >= p.tickUpper) revert InvalidAtomicPlan();
        uint160 lower = TickMath.getSqrtRatioAtTick(p.tickLower);
        uint160 upper = TickMath.getSqrtRatioAtTick(p.tickUpper);
        // Require strict interior price; a boundary cannot absorb both tokens.
        if (price <= lower || price >= upper) revert InvalidAtomicPlan();
        uint256 l0 = FullMath.mulDiv(f0, FullMath.mulDiv(price, upper, Q96), upper - price);
        uint256 l1 = FullMath.mulDiv(f1, Q96, price - lower);
        uint256 liquidity = l0 < l1 ? l0 : l1;
        // One liquidity unit protects the token rounding-up at the hook.
        if (liquidity > 1) liquidity--;
        if (liquidity < p.minLiquidity || liquidity > type(uint128).max) revert LiquidityBelowMinimum();
        uint256 rangeId = uint256(keccak256(abi.encode(poolId, p.tickLower, p.tickUpper)));
        uint256 sharesBefore = IFablesWithdrawHook(p.key.hooks).balanceOf(address(this), rangeId);
        IFablesWithdrawHook(p.key.hooks).deposit(p.key, p.tickLower, p.tickUpper,
            uint128(liquidity), uint128(f0), uint128(f1), p.deadline);
        uint256 sharesAfter = IFablesWithdrawHook(p.key.hooks).balanceOf(address(this), rangeId);
        if (sharesAfter != sharesBefore + liquidity) revert PositionMintMismatch();
        uint256 after0 = t0.balanceOf(address(this));
        uint256 after1 = t1.balanceOf(address(this));
        if (after0 < protected0 || after1 < protected1 || after0 > b0 || after1 > b1) revert BalanceChanged();
        uint256 r0 = after0 - protected0;
        uint256 r1 = after1 - protected1;
        if (r0 > FullMath.mulDiv(f0, p.maxResidualBps, 10000) + 2
            || r1 > FullMath.mulDiv(f1, p.maxResidualBps, 10000) + 2) revert ExcessResidual(r0, r1);
        // Clear any unused cap inside the same transaction.
        _approve(t0, p.key.hooks, 0);
        _approve(t1, p.key.hooks, 0);
        emit AtomicDeposited(poolId, uint128(liquidity), uint128(f0), uint128(f1), r0, r1);
    }

    function _validateRouter(AtomicDeposit calldata p, IFablesRegistryGuard.Pool[] memory pools) private view {
        (bytes memory commands, bytes[] memory inputs, uint256 deadline) =
            abi.decode(p.routerData[4:], (bytes, bytes[], uint256));
        if (commands.length != 1 || inputs.length != 1 || deadline != p.deadline) revert InvalidAtomicPlan();
        address tokenIn = p.tokenIn == 0 ? p.key.currency0 : p.key.currency1;
        address tokenOut = p.tokenIn == 0 ? p.key.currency1 : p.key.currency0;
        if (commands[0] == 0x10) {
            (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
            if (keccak256(actions) != keccak256(hex"060c0f") || params.length != 3) revert InvalidAtomicPlan();
            V4Swap memory swap = abi.decode(params[0], (V4Swap));
            (address settleToken, uint256 settleAmount) = abi.decode(params[1], (address, uint256));
            (address takeToken, uint256 takeMin) = abi.decode(params[2], (address, uint256));
            if (keccak256(abi.encode(swap.key)) != p.swapPoolId
                || swap.key.currency0 != p.key.currency0 || swap.key.currency1 != p.key.currency1
                || swap.zeroForOne != (p.tokenIn == 0) || swap.amountIn != p.amountIn || swap.minOut != p.minOut
                || swap.minHopPrice != 0 || swap.hookData.length != 0
                || settleToken != tokenIn || settleAmount != p.amountIn
                || takeToken != tokenOut || takeMin != p.minOut) revert InvalidAtomicPlan();
            // Pure Uniswap pools have no hook. Hooked swap routes must be
            // registered Fables pools, not arbitrary external hook contracts.
            if (swap.key.hooks != address(0)) {
                bool registered;
                for (uint256 i; i < pools.length; i++) {
                    if (pools[i].active && pools[i].id == p.swapPoolId
                        && keccak256(abi.encode(pools[i].key)) == p.swapPoolId) { registered = true; break; }
                }
                if (!registered) revert InvalidHook(swap.key.hooks);
            }
        } else if (commands[0] == 0x00) {
            (address recipient, uint256 amountIn, uint256 minOut, bytes memory path,
                bool payerIsUser, uint256[] memory hopPrices) =
                abi.decode(inputs[0], (address, uint256, uint256, bytes, bool, uint256[]));
            if (p.swapPoolId != bytes32(0) || recipient != address(this) || !payerIsUser || amountIn != p.amountIn || minOut != p.minOut
                || path.length < 43 || (path.length - 20) % 23 != 0 || hopPrices.length != 0) revert InvalidAtomicPlan();
            address first; address last;
            assembly ("memory-safe") {
                first := shr(96, mload(add(path, 32)))
                last := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
            }
            if (first != tokenIn || last != tokenOut) revert InvalidAtomicPlan();
        } else revert InvalidAtomicPlan();
    }

    function _approve(IERC20Guard token, address spender, uint256 amount) private {
        uint256 old = token.allowance(address(this), spender);
        if (old != amount) {
            if (old != 0) _approveCall(address(token), spender, 0);
            if (amount != 0) _approveCall(address(token), spender, amount);
        }
        if (token.allowance(address(this), spender) != amount) revert ApprovalFailed();
    }

    function _approveCall(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeCall(IERC20Guard.approve, (spender, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert ApprovalFailed();
    }

    function guardedWithdrawAndClaim(
        IFablesWithdrawHook.PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        address recipient,
        uint128 amount0Min,
        uint128 amount1Min,
        uint256 deadline,
        uint16 walk
    ) external {
        if (address(this) == IMPLEMENTATION) revert DirectImplementationCall();
        if (msg.sender != address(this)) revert OnlySelfCall();
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (key.hooks == address(0)) revert InvalidHook(key.hooks);
        if (liquidity == 0) revert ZeroLiquidity();
        if (recipient != address(this)) revert InvalidRecipient(recipient);

        bytes32 poolId = keccak256(abi.encode(key));
        (, int24 currentTick,,) = IStateView(STATE_VIEW).getSlot0(poolId);
        if (currentTick >= tickLower && currentTick < tickUpper) {
            revert InRange(currentTick, tickLower, tickUpper);
        }

        IFablesWithdrawHook(key.hooks).withdrawAndClaim(
            key,
            tickLower,
            tickUpper,
            liquidity,
            recipient,
            amount0Min,
            amount1Min,
            deadline,
            walk
        );
    }
}
