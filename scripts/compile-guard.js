import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const sourcePath = path.resolve('contracts/Fables7702Guard.sol');
const source = fs.readFileSync(sourcePath, 'utf8');
const contractsRoot = path.resolve('contracts');
const nodeModulesRoot = path.resolve('node_modules');
const input = {
  language: 'Solidity',
  sources: { 'Fables7702Guard.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': [
      'abi', 'evm.bytecode.object', 'evm.deployedBytecode.object',
      'evm.deployedBytecode.immutableReferences'
    ] } }
  }
};
const importCallback = (importPath) => {
  const candidates = [
    path.resolve(contractsRoot, importPath),
    path.resolve(process.cwd(), importPath),
    path.resolve(nodeModulesRoot, importPath)
  ];
  const file = candidates.find((candidate) =>
    (candidate.startsWith(`${contractsRoot}${path.sep}`)
      || candidate.startsWith(`${nodeModulesRoot}${path.sep}`))
      && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!file) return { error: `Import not found or outside contracts/node_modules: ${importPath}` };
  return { contents: fs.readFileSync(file, 'utf8') };
};
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: importCallback }));
const errors = (output.errors || []).filter((x) => x.severity === 'error');
if (errors.length) throw new Error(errors.map((x) => x.formattedMessage).join('\n'));
const contract = output.contracts['Fables7702Guard.sol'].Fables7702Guard;
const requiredFunctions = new Set([
  'guardVersion', 'IMPLEMENTATION', 'guardedWithdrawAndClaim', 'atomicSwapAndDeposit'
]);
const abiFunctions = new Set(contract.abi.filter((x) => x.type === 'function').map((x) => x.name));
for (const fn of requiredFunctions) {
  if (!abiFunctions.has(fn)) throw new Error(`Compiled guard ABI is missing required function: ${fn}`);
}
const artifact = {
  contractName: 'Fables7702Guard',
  compiler: solc.version(),
  abi: contract.abi,
  bytecode: '0x' + contract.evm.bytecode.object,
  deployedBytecode: '0x' + contract.evm.deployedBytecode.object,
  immutableReferences: contract.evm.deployedBytecode.immutableReferences
};
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/Fables7702Guard.json', JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({ ok: true, compiler: artifact.compiler, bytecodeBytes: (artifact.bytecode.length - 2) / 2 }, null, 2));
