import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { Interface } from 'ethers';
import { EIP7702_GUARD_ABI, HOOK_ABI } from '../src/abi.js';

const root = process.cwd();

function compileGuardInMemory() {
  const contractsRoot = path.resolve(root, 'contracts');
  const modulesRoot = path.resolve(root, 'node_modules');
  const source = fs.readFileSync(path.join(contractsRoot, 'Fables7702Guard.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: {
      'Fables7702Guard.sol': { content: source },
      'GuardAbiProbe.sol': { content: `
        // Compile-time ABI probe: expose the guard's internal tuples so they can
        // be compared with the separately published Fables and Kyber ABIs.
        pragma solidity ^0.8.24;
        import "./Fables7702Guard.sol";
        contract GuardAbiProbe {
          function reposition(IFablesZapGuard.Reposition calldata p,
              IFablesZapGuard.Routing calldata r) external pure returns (bytes32) {
            return keccak256(abi.encode(p, r));
          }
          function permit(IFablesZapGuard.BatchPermit calldata p)
              external pure returns (bytes32) { return keccak256(abi.encode(p)); }
          function swap(IFablesZapGuard.SwapExecution calldata s)
              external pure returns (bytes32) { return keccak256(abi.encode(s)); }
        }
      ` }
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import(importPath) {
      const candidates = [
        path.resolve(contractsRoot, importPath),
        path.resolve(root, importPath),
        path.resolve(modulesRoot, importPath)
      ];
      const file = candidates.find(candidate =>
        (candidate.startsWith(`${contractsRoot}${path.sep}`)
          || candidate.startsWith(`${modulesRoot}${path.sep}`))
        && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      return file
        ? { contents: fs.readFileSync(file, 'utf8') }
        : { error: `Import not found or outside contracts/node_modules: ${importPath}` };
    }
  }));
  const errors = (output.errors ?? []).filter(item => item.severity === 'error');
  assert.deepEqual(errors, [], errors.map(item => item.formattedMessage).join('\n'));
  const contract = output.contracts['Fables7702Guard.sol'].Fables7702Guard;
  return {
    abi: contract.abi,
    deployedBytecode: contract.evm.deployedBytecode.object,
    probeAbi: output.contracts['GuardAbiProbe.sol'].GuardAbiProbe.abi
  };
}

const officialZapAbi = JSON.parse(fs.readFileSync(
  path.join(root, 'src/execution/fables-zap-abi.json'), 'utf8'));
const zap = new Interface(officialZapAbi);
const kyber = new Interface([
  'function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns(uint256 amountOut)'
]);

test('compiled guard ABI matches the application ABI and remains EIP-170 deployable', () => {
  const compiled = compileGuardInMemory();
  const compiledInterface = new Interface(compiled.abi);
  const appInterface = new Interface(EIP7702_GUARD_ABI);
  const probeInterface = new Interface(compiled.probeAbi);

  for (const signature of [
    'isValidSignature(bytes32,bytes)',
    'guardedRepositionAndClaim((uint256,uint256,uint256,uint256,int24[],int24[],uint16,uint16,bytes))'
  ]) {
    assert.equal(compiledInterface.getFunction(signature).selector,
      appInterface.getFunction(signature).selector, `application ABI drift: ${signature}`);
  }
  assert.equal(compiledInterface.getEvent('OfficialRepositioned').topicHash,
    appInterface.getEvent('OfficialRepositioned').topicHash);
  assert.equal(compiledInterface.getFunction('isValidSignature').selector, '0x1626ba7e');
  assert.ok(compiled.deployedBytecode.length / 2 < 24_576,
    'compiled deployed bytecode must fit the EIP-170 size limit');

  const claim = new Interface(HOOK_ABI).getFunction('claimFees');
  assert.equal(claim.format('sighash'),
    'claimFees((address,address,uint24,int24,address),int24,int24,address,uint16)');
  assert.equal(claim.selector, '0x4e8d0048');

  const officialReposition = zap.getFunction('reposition');
  const guardReposition = probeInterface.getFunction('reposition');
  assert.deepEqual(guardReposition.inputs.map(input => input.format('sighash')),
    officialReposition.inputs.map(input => input.format('sighash')));
  const officialPermit = zap.getFunction('withPermit2').inputs[0];
  assert.equal(probeInterface.getFunction('permit').inputs[0].format('sighash'),
    officialPermit.format('sighash'));
  assert.equal(probeInterface.getFunction('swap').inputs[0].format('sighash'),
    kyber.getFunction('swap').inputs[0].format('sighash'));
});

test('official reposition, Permit2 wrapper, and pinned Kyber description encode/decode compatibly', () => {
  assert.equal(zap.getFunction('reposition').selector, '0x7ff314f0');
  assert.equal(zap.getFunction('withPermit2').selector, '0xf9617844');
  assert.equal(kyber.getFunction('swap').selector, '0xe21fd0e9');

  const currency0 = '0x0000000000000000000000000000000000000001';
  const currency1 = '0x0000000000000000000000000000000000000002';
  const hook = '0x0000000000000000000000000000000000000003';
  const zapAddress = '0x89d862d7a189627B229aa3Ac28Ae565f6Fb89d1f';
  const kyberTarget = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
  const kyberExecutor = '0x8F10B468b06c6FD214B65F87778827F7D113f996';
  const poolKey = [currency0, currency1, 3000, 60, hook];
  const deadline = 2_000_000_000n;
  const amount0 = 100n;
  const amount1 = 200n;

  const kyberCall = kyber.encodeFunctionData('swap', [[
    kyberExecutor,
    '0x0000000000000000000000000000000000000000',
    '0x1234',
    [currency1, currency0, [kyberExecutor], [amount1], [], [], zapAddress,
      amount1, 190n, 512, '0x'],
    '0x'
  ]]);
  const repositionCall = zap.encodeFunctionData('reposition', [
    [poolKey, -600, 600, 1000n, -120, 120, 100n, deadline, zapAddress, amount0, amount1],
    [[ [[], kyberTarget, false, amount1, 0, kyberCall] ], 5]
  ]);
  const permit = [[[currency0, amount0], [currency1, amount1]], 7n, deadline];
  const routerData = zap.encodeFunctionData('withPermit2', [
    permit, `0x${'11'.repeat(65)}`, repositionCall
  ]);
  const plan = [
    1000n, 2000n, amount0, amount1,
    [-600], [600], 1000, 50, routerData
  ];

  const wrapped = zap.decodeFunctionData('withPermit2', routerData);
  assert.equal(wrapped[0].deadline, deadline);
  assert.equal(wrapped[0].permitted.length, 2);
  assert.equal(wrapped[2], repositionCall);
  const reposition = zap.decodeFunctionData('reposition', wrapped[2]);
  assert.equal(reposition[0].recipient, zapAddress);
  assert.equal(reposition[0].add0, amount0);
  assert.equal(reposition[0].add1, amount1);
  assert.equal(reposition[1].legs.length, 1);
  const decodedSwap = kyber.decodeFunctionData('swap', reposition[1].legs[0].data);
  assert.equal(decodedSwap[0].desc.srcToken, currency1);
  assert.equal(decodedSwap[0].desc.dstToken, currency0);
  assert.equal(decodedSwap[0].desc.srcAmounts[0], amount1);
  assert.equal(decodedSwap[0].desc.feeReceivers.length, 0);
  assert.equal(decodedSwap[0].desc.flags, 512n);

  const guard = new Interface(EIP7702_GUARD_ABI);
  const encodedGuardCall = guard.encodeFunctionData('guardedRepositionAndClaim', [plan]);
  const decodedGuardCall = guard.decodeFunctionData('guardedRepositionAndClaim', encodedGuardCall);
  assert.equal(decodedGuardCall[0].routerData, routerData);
  assert.equal(decodedGuardCall[0].claimLower[0], -600n);
  assert.equal(decodedGuardCall[0].claimUpper[0], 600n);
});
