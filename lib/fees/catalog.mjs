// Public deployment identities only. Fungun O1 pins are reused verbatim.
// New pins were checked read-only against the published deployment/source ABIs.
export const SOURCE_INFO = [
  {
    id: "o1",
    name: "O1 Exchange",
    mark: "o1",
    description:
      "Wallet-index discovery with onchain-verified creator, referrer and recipient balances across seven reviewed escrows.",
    note: "Index completion means all indexed wallet positions were checked; recent activity can take time to appear in the index. Shared escrow balances are grouped by asset. Holder dividends and burn-only $O routes are excluded.",
    url: "https://launch.o1.exchange",
  },
  {
    id: "long",
    name: "Long / Longbow",
    mark: "↗",
    description: "Beneficiary fees in the shared Doppler locked-pool manager.",
    note: "Long and Longbow share a manager, so they are combined to avoid double-counting. Migrated pools and separate hook payouts are excluded.",
    url: "https://long.xyz",
  },
  {
    id: "pons",
    name: "pons",
    mark: "p",
    description: "Native and token balances in the v2 escrow, plus the reviewed v1 locker.",
    note: "Unswept fees and legacy deployments are shown separately; escrow balances alone are not lifetime earnings. Buyback vesting is excluded.",
    url: "https://www.ponsfamily.com",
  },
];
// Multicall3 runtime checked read-only on chain 4663. Used only for bounded
// getLaunchedToken reads; executable wallet claims never target this contract.
export const MULTICALL = {
  address: "0xca11bde05977b3631167028862be2a173976ca11",
  hash: "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891",
};
export const O1 = [
  {
    id: "o1-1",
    address: "0xf5681c4c0dc0c2e32c9d127b3cc0fc992b584553",
    hash: "0x016bd8362dedaead52326c486679a6812ee98088b98d6195b34d87dfe54128cb",
    start: 2131131,
    version: "legacy",
    kind: "o1",
  },
  {
    id: "o1-2",
    address: "0x00d5701a92794c3744428b62646e7bc4e77a0a9a",
    hash: "0x3402d890c78ca6947a223b7adc8362fd44cc22b322a3a453c344bc27088b143a",
    start: 4415287,
    version: "legacy",
    kind: "o1",
  },
  {
    id: "o1-3",
    address: "0x32f7a9a05bd62487d085ad494e14ec42543e19d2",
    hash: "0x8315a3554c1d17721a46d32491c7f9c4f09ce5b034e38475482cb50e4585ba9c",
    start: 6131279,
    version: "legacy",
    kind: "o1",
  },
  {
    id: "o1-4",
    address: "0x4f2b1cda8748cd64c56039bf5e2e54bc13d4a3d7",
    hash: "0x96df59104ba0c6143bb59f17c4acde6d9ac93e0716df92b62bf4aacb3c3274ae",
    start: 18487505,
    version: "legacy",
    kind: "o1",
  },
  {
    id: "o1-5",
    address: "0xc5444b417a04a7e1b9c1e327c7d499803c14e5ef",
    hash: "0xa470389a90e55bffb8891ab2d30113f55b6a566ca98c6a3e3e6497f5af06a999",
    start: 48880218,
    version: "current",
    kind: "o1",
  },
  {
    id: "o1-tax",
    address: "0x1Dede99A17e1C7775541d73B675470Ba4BeE0318",
    hash: "0x85eb44f56e18a8fb80d6ddc627c87f251dfa1580350362d8ee16493160966973",
    start: 73128178,
    version: "current",
    kind: "o1",
  },
  {
    id: "o1-child",
    address: "0x4Bf2F5636778ce67C545fD26de46CFe5402d0152",
    hash: "0xf042b5ba8ab967f5dce1ef56bc232c0dd1356b0e432511ffd7b882985f4e9d47",
    start: 83656063,
    version: "current",
    kind: "o1",
  },
];
export const LONG = {
  id: "long-manager",
  kind: "long",
  address: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544",
  hash: "0xc41a91106002f15bf70ae266824317f3f3ac638ac72ca5253bae395fa47ee631",
  start: 646861,
};
export const LONG_HOOK = {
  address: "0xc16c826f75338a5ea626f94f8992191b4ce5aba2",
  hash: "0xee9467b80536fe71bb3d14e610ec4e2a3458f3f52e0b328128a5a520eb3dd575",
};
export const PONS = {
  id: "pons-v2",
  kind: "pons",
  address: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  hash: "0xf25f75cfbc1637ba068dc34f69098fa4e8a80f8ee8fe7bf7820594e0b3fed2f1",
  start: 26841845,
};
export const PONS_FACTORY = {
  id: "pons-factory",
  kind: "pons-factory",
  address: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  hash: "0x89a27da6f703e0a7cdd4f233e7cb57604ff75b164530962d3ff7cf8483a67d84",
  start: 26841846,
};
export const PONS_HOOK = {
  address: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  hash: "0xc21b1e6c1b45403e81a581f22ed6d9c747997af1cfdac1b1dc9f4b1d346a10db",
};
export const PONS_V1 = {
  id: "pons-v1",
  kind: "pons-v1",
  address: "0x736D76699C26D0d966744cAe304C000d471f7F35",
  hash: "0xa7880a625a649da833de5597c9f41585bb75e20ef91d45830ccc6f4e49cc281c",
  start: 8991102,
};
export const targets = { o1: O1, long: [LONG], pons: [PONS, PONS_V1, PONS_FACTORY] };
