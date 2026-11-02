// Every in-game text lives here. {c} = coin, {a} = amount.
export const S = {
  loading: 'Watering the crops... and checking the gas fees.',
  tut: 'Pick a seed. Tap a plot. Wait. Harvest. Number go up. Simple.',
  start: 'Start farming',
  sim: 'Simulation only. Not financial advice.',
  news: [
    'DOGE is up 200%. Your chickens are feeling the FOMO.',
    'Farmer Satoshi: "My grandpa has been HODLing wheat since 2009."',
    'BREAKING: Corn hits an all-time high. Scarecrows are bullish.',
    'Whales spotted near the pumpkin patch.',
    'Gas fees are high today. So is the corn.',
    'WAGMI. Probably. Go water your crops.'
  ],
  sold: [
    "I'll pay in {c}, but I want my change in BTC. Got {a}!",
    '{a} {c} received. Pleasure doing business!',
    'Paid in {c}. Please do not tell my wife. (+{a})'
  ],
  poor: c => `Not enough ${c}. Try a swap!`,
  grow: s => `Still growing... ${s}s left.`,
  locked: (u, c) => `Locked plot. Costs $${u} in ${c}.`,
  planted: 'Planted! Now we wait. HODL.',
  unlocked: 'New plot unlocked. Land is the real alpha.',
  swapOk: 'Swapped! The gas fee says thanks.',
  badSwap: 'Ouch. The gas fee cost more than the corn.',
  same: 'Pick two different coins.',
  tiny: 'Too small. The gas fee would eat it all.'
};
