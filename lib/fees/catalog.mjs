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
    id: "bags",
    name: "Bags",
    mark: "b",
    description: "Wallet-index discovery with onchain-verified creator and partner WETH fees; registry discovery is the fallback.",
    note: "Index completion covers the returned wallet positions and can lag recent activity. Truncated index lists fall back to registry discovery. Amounts include a successful read-only sweep preview. Current v2 beacon deployments only; legacy v1 and holder dividends are excluded.",
    url: "https://bags.fm",
  },
  {
    id: "bankr",
    name: "Bankr",
    mark: "B",
    description: "Bankr-indexed creator fees in the shared Doppler manager and the reviewed quote-only hook ledger.",
    note: "The Bankr API prioritizes creator positions; the shared onchain event index also discovers transferred beneficiaries in the reviewed manager and hook ledgers. Unreviewed hook versions, migrated pools and vesting are excluded. Shared Long/Doppler positions are counted once.",
    url: "https://bankr.bot",
  },
  {
    id: "long",
    name: "Long / Longbow",
    mark: "↗",
    description: "Shared event-index discovery with onchain-verified beneficiary fees in the Doppler locked-pool manager.",
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
// Public pins verified with read-only cast calls on chain 4663, 18 October 2026.
// Pin implementation identities as well as proxy runtimes: a proxy hash alone
// does not protect a claim against an upgrade.
export const BAGS = {
  id: "bags-v2", kind: "bags", start: 7887312,
  address: "0xe8cc4431adf8b5a847c113ef0c6af9043219cb37",
  hash: "0x81489932a2c2dc73badc783623df7631238faed2c6b5119b30eb7f0297825871",
};
export const BAGS_FACTORY_IMPL = {
  address: "0x7dfa0131f6c8626f199a2e33e49dfb5660e6ef1c",
  hash: "0xfef65b92c70d5b9a9740d931057f5e6c7fa6edb313eda7c5a0132bd69d9fe603",
};
export const BAGS_BEACON = {
  address: "0xdff07d39c5332c602e06fa64f0a97c92fd8537e0",
  hash: "0x1c9dc398a646587fa3ea7cbd9e189f90e9682ae0986e4baaf8187ed341ef05a4",
};
export const BAGS_FEE_IMPL = {
  address: "0xd169ebd0aa9e42f2410f92740d00cd2228d98a1a",
  hash: "0xc0745da219cf791ca11e58cd5fd7dde07c0efd7633b422c13a2964e015d32b1c",
};
export const BAGS_HOOK = {
  address: "0x2380abf72c17aabab76480244759ac7e2932eecc",
  hash: "0x61ee07a84bcb4b0e4e48e1d44b4591f022853a06e95face68d5043a3331f1966",
};
export const BAGS_FEE_PROXY_HASH = "0xb1edec7d84db722637a5f8b9df1d3566fb1e048c2f5684754f39df2948534987";
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const BANKR_HOOK = {
  id: "bankr-hook", kind: "bankr", start: LONG.start,
  address: "0x9982538f41f2ae29ddb9d3d9307010052984fdbb",
  hash: "0xb9fca90e784b350067d7ccdb4712929f484c38e7856e9e67c02d882fb11c4ce9",
};
export const targets = { o1: O1, bags: [BAGS], bankr: [LONG, BANKR_HOOK], long: [LONG], pons: [PONS, PONS_V1, PONS_FACTORY] };
