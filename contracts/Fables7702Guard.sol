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
    function allowance(address owner, address spender, uint256 rangeId) external view returns (uint256);
    function approve(address spender, uint256 rangeId, uint256 amount) external returns (bool);
    function claimFees(PoolKey calldata key, int24 lower, int24 upper, address recipient, uint16 walk) external;

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

interface IFablesZapGuard {
    struct Hop { IFablesWithdrawHook.PoolKey key; bool zeroForOne; }
    struct Leg { Hop[] route; address target; bool zeroForOne; uint256 amountIn; uint16 shareBps; bytes data; }
    struct Routing { Leg[] legs; uint16 maxFeeBps; }
    struct Reposition {
        IFablesWithdrawHook.PoolKey key; int24 oldLower; int24 oldUpper; uint128 shares;
        int24 newLower; int24 newUpper; uint128 minLiquidity; uint256 deadline;
        address recipient; uint256 add0; uint256 add1;
    }
    struct TokenPermission { address token; uint256 amount; }
    struct BatchPermit { TokenPermission[] permitted; uint256 nonce; uint256 deadline; }
    struct SwapDescription {
        address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts;
        address[] feeReceivers; uint256[] feeAmounts; address dstReceiver;
        uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit;
    }
    struct SwapExecution { address callTarget; address approveTarget; bytes targetData; SwapDescription desc; bytes clientData; }
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
    address internal constant FABLES_ZAP = 0x89d862d7a189627B229aa3Ac28Ae565f6Fb89d1f;
    bytes32 internal constant FABLES_ZAP_CODE_HASH = 0x92ba1c510d3aa52ad14a29cc41a74374405d4c881b08b176cc11b0accfa2cbbb;
    address internal constant KYBER_ZAP_TARGET = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5;
    address internal constant KYBER_EXECUTOR = 0x8F10B468b06c6FD214B65F87778827F7D113f996;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
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
    struct OfficialReposition {
        uint256 expectedBalance0; uint256 expectedBalance1;
        uint256 funding0; uint256 funding1;
        int24[] claimLower; int24[] claimUpper;
        uint16 walk; uint16 maxResidualBps; bytes routerData;
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
    event OfficialRepositioned(bytes32 indexed poolId, uint256 indexed oldRangeId,
        uint256 indexed newRangeId, uint128 liquidity, uint256 claimed0, uint256 claimed1,
        uint256 residual0, uint256 residual1);

    receive() external payable {}
    fallback() external payable {}

    function guardVersion() external pure returns (bytes32) {
        return keccak256("Fables7702Guard/v3");
    }

    /// @notice Permit2 treats a delegated EOA as a contract signer. Validate
    /// only that EOA's own canonical signature; no operator can sign for it.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (address(this) == IMPLEMENTATION || block.chainid != ROBINHOOD_CHAIN_ID
            || msg.sender != PERMIT2 || signature.length != 65) return 0xffffffff;
        bytes32 r; bytes32 s; uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if ((v != 27 && v != 28) || uint256(s) == 0
            || uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0)
            return 0xffffffff;
        return ecrecover(digest, v, r, s) == address(this) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    /// @notice Claim earned fees and reposition through the pinned official
    /// router atomically, retaining the OOR check at transaction inclusion.
    function guardedRepositionAndClaim(OfficialReposition calldata plan) external {
        if (address(this) == IMPLEMENTATION) revert DirectImplementationCall();
        if (msg.sender != address(this)) revert OnlySelfCall();
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (FABLES_ZAP.codehash != FABLES_ZAP_CODE_HASH || plan.routerData.length < 4
            || plan.maxResidualBps > 50 || plan.walk > 1000 || plan.claimLower.length != plan.claimUpper.length
            || plan.claimLower.length > 16) revert InvalidAtomicPlan();
        bytes memory data = plan.routerData;
        bool permitted = bytes4(plan.routerData[:4]) == 0xf9617844;
        IFablesZapGuard.BatchPermit memory permit;
        if (permitted) {
            bytes memory signature;
            (permit, signature, data) = abi.decode(plan.routerData[4:], (IFablesZapGuard.BatchPermit, bytes, bytes));
            if (signature.length == 0 || data.length < 4) revert InvalidAtomicPlan();
        }
        bytes4 selector;
        assembly ("memory-safe") { selector := mload(add(data, 32)) }
        if (selector != 0x7ff314f0) revert InvalidAtomicPlan();
        IFablesZapGuard.Reposition memory p;
        IFablesZapGuard.Routing memory r;
        // Remove the selector without invoking arbitrary calldata targets.
        bytes memory args = new bytes(data.length - 4);
        assembly ("memory-safe") { mcopy(add(args, 32), add(data, 36), mload(args)) }
        (p, r) = abi.decode(args, (IFablesZapGuard.Reposition, IFablesZapGuard.Routing));
        bytes32 poolId = keccak256(abi.encode(p.key));
        IFablesRegistryGuard.Pool[] memory pools = IFablesRegistryGuard(REGISTRY).activePools();
        if (!_registered(p.key, poolId, pools) || p.key.currency0 == address(0)
            || p.key.currency0 >= p.key.currency1 || p.key.tickSpacing <= 0
            || !_validRange(p.oldLower, p.oldUpper, p.key.tickSpacing)
            || !_validRange(p.newLower, p.newUpper, p.key.tickSpacing)
            || (p.oldLower == p.newLower && p.oldUpper == p.newUpper)
            || p.shares == 0 || p.minLiquidity == 0 || p.recipient != address(this)
            || p.deadline < block.timestamp || p.deadline > block.timestamp + 1200
            || r.maxFeeBps > 5 || r.legs.length > 3) revert InvalidAtomicPlan();
        (uint160 beforePrice, int24 tick,,) = IStateView(STATE_VIEW).getSlot0(poolId);
        if (tick >= p.oldLower && tick < p.oldUpper) revert InRange(tick, p.oldLower, p.oldUpper);
        if (tick < p.newLower || tick >= p.newUpper) revert InvalidAtomicPlan();
        _validateOfficialRouting(p, r, pools);
        IERC20Guard t0 = IERC20Guard(p.key.currency0);
        IERC20Guard t1 = IERC20Guard(p.key.currency1);
        uint256 b0 = t0.balanceOf(address(this)); uint256 b1 = t1.balanceOf(address(this));
        if (b0 != plan.expectedBalance0 || b1 != plan.expectedBalance1
            || plan.funding0 > b0 || plan.funding1 > b1) revert BalanceChanged();
        uint256 protected0 = b0 - plan.funding0; uint256 protected1 = b1 - plan.funding1;
        IFablesWithdrawHook hook = IFablesWithdrawHook(p.key.hooks);
        uint256 oldId = uint256(keccak256(abi.encode(poolId, p.oldLower, p.oldUpper)));
        uint256 newId = uint256(keccak256(abi.encode(poolId, p.newLower, p.newUpper)));
        if (hook.balanceOf(address(this), oldId) != p.shares) revert PositionMintMismatch();
        uint256 newBefore = hook.balanceOf(address(this), newId);
        bool claimsOld;
        for (uint256 i; i < plan.claimLower.length; ++i) {
            if (!_validRange(plan.claimLower[i], plan.claimUpper[i], p.key.tickSpacing)) revert InvalidAtomicPlan();
            for (uint256 j; j < i; ++j) if (plan.claimLower[j] == plan.claimLower[i]
                && plan.claimUpper[j] == plan.claimUpper[i]) revert InvalidAtomicPlan();
            if (plan.claimLower[i] == p.oldLower && plan.claimUpper[i] == p.oldUpper) claimsOld = true;
            hook.claimFees(p.key, plan.claimLower[i], plan.claimUpper[i], address(this), plan.walk);
        }
        if (!claimsOld) revert InvalidAtomicPlan();
        uint256 claimed0 = t0.balanceOf(address(this)) - b0;
        uint256 claimed1 = t1.balanceOf(address(this)) - b1;
        if (p.add0 > plan.funding0 + claimed0 || p.add1 > plan.funding1 + claimed1) revert BalanceChanged();
        uint256 a0 = t0.allowance(address(this), PERMIT2); uint256 a1 = t1.allowance(address(this), PERMIT2);
        if (p.add0 + p.add1 > 0) {
            if (!permitted || permit.deadline != p.deadline || permit.permitted.length == 0
                || permit.permitted.length > 2) revert InvalidAtomicPlan();
            bool found0 = p.add0 == 0; bool found1 = p.add1 == 0;
            for (uint256 i; i < permit.permitted.length; ++i) {
                IFablesZapGuard.TokenPermission memory item = permit.permitted[i];
                if (item.token == p.key.currency0 && !found0 && item.amount == p.add0) found0 = true;
                else if (item.token == p.key.currency1 && !found1 && item.amount == p.add1) found1 = true;
                else revert InvalidAtomicPlan();
            }
            if (!found0 || !found1) revert InvalidAtomicPlan();
            if (a0 < p.add0) _approve(t0, PERMIT2, p.add0);
            if (a1 < p.add1) _approve(t1, PERMIT2, p.add1);
        } else if (permitted) revert InvalidAtomicPlan();
        if (!hook.approve(FABLES_ZAP, oldId, p.shares)
            || hook.allowance(address(this), FABLES_ZAP, oldId) != p.shares) revert ApprovalFailed();
        (bool ok, bytes memory result) = FABLES_ZAP.call(plan.routerData);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        if (permitted) result = abi.decode(result, (bytes));
        uint128 minted = abi.decode(result, (uint128));
        if (minted < p.minLiquidity || hook.balanceOf(address(this), oldId) != 0
            || hook.balanceOf(address(this), newId) != newBefore + minted) revert PositionMintMismatch();
        if (!hook.approve(FABLES_ZAP, oldId, 0)
            || hook.allowance(address(this), FABLES_ZAP, oldId) != 0) revert ApprovalFailed();
        _approve(t0, PERMIT2, a0); _approve(t1, PERMIT2, a1);
        uint256 after0 = t0.balanceOf(address(this)); uint256 after1 = t1.balanceOf(address(this));
        if (after0 < protected0 || after1 < protected1) revert BalanceChanged();
        uint256 residual0 = after0 - protected0; uint256 residual1 = after1 - protected1;
        (uint160 afterPrice, int24 afterTick,,) = IStateView(STATE_VIEW).getSlot0(poolId);
        if (afterTick < p.newLower || afterTick >= p.newUpper || beforePrice == 0) revert InvalidAtomicPlan();
        (uint256 used0, uint256 used1) = _amounts(afterPrice, p.newLower, p.newUpper, minted);
        if (residual0 > FullMath.mulDiv(used0 + residual0, plan.maxResidualBps, 10000) + 2
            || residual1 > FullMath.mulDiv(used1 + residual1, plan.maxResidualBps, 10000) + 2) revert ExcessResidual(residual0, residual1);
        emit OfficialRepositioned(poolId, oldId, newId, minted, claimed0, claimed1, residual0, residual1);
    }

    function _validRange(int24 lower, int24 upper, int24 spacing) private pure returns (bool) {
        return spacing > 0 && lower >= -887272 && upper <= 887272 && lower < upper
            && lower % spacing == 0 && upper % spacing == 0;
    }
    function _registered(IFablesWithdrawHook.PoolKey memory key, bytes32 id,
        IFablesRegistryGuard.Pool[] memory pools) private pure returns (bool) {
        for (uint256 i; i < pools.length; ++i) if (pools[i].active && pools[i].id == id
            && keccak256(abi.encode(pools[i].key)) == id && keccak256(abi.encode(key)) == id) return true;
        return false;
    }
    function _validateOfficialRouting(IFablesZapGuard.Reposition memory p,
        IFablesZapGuard.Routing memory r, IFablesRegistryGuard.Pool[] memory pools) private pure {
        for (uint256 i; i < r.legs.length; ++i) {
            IFablesZapGuard.Leg memory leg = r.legs[i];
            if (leg.shareBps > 20000) revert InvalidAtomicPlan();
            if (leg.target == address(0)) {
                if (leg.route.length == 0 || leg.route.length > 4 || leg.data.length != 0 || leg.amountIn != 0) revert InvalidAtomicPlan();
                address token = leg.zeroForOne ? p.key.currency0 : p.key.currency1;
                for (uint256 j; j < leg.route.length; ++j) {
                    IFablesZapGuard.Hop memory hop = leg.route[j];
                    if ((hop.zeroForOne ? hop.key.currency0 : hop.key.currency1) != token
                        || (hop.key.hooks != address(0) && !_registered(hop.key, keccak256(abi.encode(hop.key)), pools))) revert InvalidAtomicPlan();
                    token = hop.zeroForOne ? hop.key.currency1 : hop.key.currency0;
                }
                if (token != (leg.zeroForOne ? p.key.currency1 : p.key.currency0)) revert InvalidAtomicPlan();
            } else {
                bytes memory routeData = leg.data; bytes4 selector;
                assembly ("memory-safe") { selector := mload(add(routeData, 32)) }
                if (leg.target != KYBER_ZAP_TARGET || leg.route.length != 0 || leg.amountIn == 0
                    || selector != 0xe21fd0e9 || leg.shareBps != 0) revert InvalidAtomicPlan();
                if (routeData.length < 4) revert InvalidAtomicPlan();
                bytes memory args = new bytes(routeData.length - 4);
                assembly ("memory-safe") { mcopy(add(args, 32), add(routeData, 36), mload(args)) }
                IFablesZapGuard.SwapExecution memory swap = abi.decode(args, (IFablesZapGuard.SwapExecution));
                address sell = leg.zeroForOne ? p.key.currency0 : p.key.currency1;
                address buy = leg.zeroForOne ? p.key.currency1 : p.key.currency0;
                if (swap.callTarget != KYBER_EXECUTOR || swap.approveTarget != address(0)
                    || swap.desc.srcToken != sell || swap.desc.dstToken != buy
                    || swap.desc.amount != leg.amountIn || swap.desc.minReturnAmount == 0
                    || swap.desc.dstReceiver != FABLES_ZAP || swap.desc.permit.length != 0
                    || swap.desc.srcReceivers.length != 1 || swap.desc.srcAmounts.length != 1
                    || swap.desc.srcReceivers[0] != KYBER_EXECUTOR || swap.desc.srcAmounts[0] != leg.amountIn
                    || swap.desc.feeReceivers.length != 0 || swap.desc.feeAmounts.length != 0
                    || swap.desc.flags != 512) revert InvalidAtomicPlan();
            }
        }
    }
    function _amounts(uint160 price, int24 tickLower, int24 tickUpper, uint128 liquidity)
        private pure returns (uint256 amount0, uint256 amount1) {
        uint160 lower = TickMath.getSqrtRatioAtTick(tickLower); uint160 upper = TickMath.getSqrtRatioAtTick(tickUpper);
        if (price < lower) price = lower; if (price > upper) price = upper;
        amount0 = FullMath.mulDiv(FullMath.mulDiv(uint256(liquidity) << 96, upper - price, upper), 1, price);
        amount1 = FullMath.mulDiv(liquidity, price - lower, Q96);
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
