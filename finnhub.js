const axios = require('axios');
require('dotenv').config();

async function getQuote(symbol) {
  const url = `https://finnhub.io/api/v1/quote`;
  const res = await axios.get(url, {
    params: {
      symbol,
      token: process.env.FINNHUB_API_KEY,
    },
  });
  // Finnhub's quote response: c = current price, v is NOT included here (quote endpoint has no volume)
  return {
    symbol,
    price: res.data.c,
    timestamp: res.data.t, // unix seconds of the last trade
  };
}

module.exports = { getQuote };