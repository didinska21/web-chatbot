// Edit the coin list here. p = base price in USD (simulation), st = stablecoin.
export const COINS = [
  {s:'BTC',p:90000,c:'#f7931a'},{s:'ETH',p:3100,c:'#627eea'},
  {s:'USDT',p:1,c:'#26a17b',st:1},{s:'BNB',p:620,c:'#f3ba2f'},
  {s:'XRP',p:2.3,c:'#8fa3b8'},{s:'SOL',p:150,c:'#9945ff'},
  {s:'USDC',p:1,c:'#2775ca',st:1},{s:'DOGE',p:0.2,c:'#c2a633'},
  {s:'TRX',p:0.26,c:'#e50915'},{s:'ADA',p:0.7,c:'#3468d1'}
];
// cost/sell in USD value, t = grow time in seconds, coin = what the seed is paid with.
export const CROPS = [
  {n:'Wheat',e:'🌾',coin:'DOGE',cost:4,sell:9,t:12,col:0xe8c547},
  {n:'Corn',e:'🌽',coin:'TRX',cost:8,sell:20,t:20,col:0xf5d742},
  {n:'Tomato',e:'🍅',coin:'ADA',cost:12,sell:30,t:30,col:0xe84b3c},
  {n:'Pumpkin',e:'🎃',coin:'XRP',cost:20,sell:55,t:45,col:0xf28c28}
];
export const LAND = {coin:'BTC', cost:50};
export const START_USD = 60; // starting value of each coin
