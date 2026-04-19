const result = require('dotenv').config();

console.log("DOTENV PARSE RESULT:", result);
console.log("BUSINESS_SHORTCODE:", process.env.BUSINESS_SHORTCODE);
console.log("CALLBACK_URL:", process.env.CALLBACK_URL);

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// serve frontend (index.html, css, js)
app.use(express.static(path.join(__dirname)));

// homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '/web/index.html'));
});

// =======================
// GET ACCESS TOKEN
// =======================
async function getToken() {
  const url =
    'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

  const auth = Buffer.from(
    `${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`
  ).toString('base64');

  const response = await axios.get(url, {
    headers: {
      Authorization: `Basic ${auth}`
    }
  });

  return response.data.access_token;
}

// =======================
// STK PUSH ROUTE
// =======================
app.post('/stkpush', async (req, res) => {
  let { phone, amount } = req.body;

  try {
    // FIX PHONE FORMAT (07XXXXXXXX -> 2547XXXXXXXX)
    if (phone.startsWith('0')) {
      phone = '254' + phone.slice(1);
    }

    const token = await getToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[-T:.Z]/g, '')
      .slice(0, 14);

    const password = Buffer.from(
      process.env.BUSINESS_SHORTCODE +
      process.env.PASSKEY +
      timestamp
    ).toString('base64');

    const stkUrl =
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

    const payload = {
      BusinessShortCode: process.env.BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: parseInt(amount),
      PartyA: phone,
      PartyB: process.env.BUSINESS_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: process.env.CALLBACK_URL,
      AccountReference: 'TestPayment',
      TransactionDesc: 'STK Push Sandbox Test'
    };

    const response = await axios.post(stkUrl, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    res.json({
      success: true,
      message: 'STK Push sent successfully',
      data: response.data
    });

  } catch (err) {
    console.log('STK ERROR:', err.response?.data || err.message);

    res.status(500).json({
      success: false,
      message: 'STK Push failed',
      error: err.response?.data || err.message
    });
  }
});

// =======================
// CALLBACK / WEBHOOK
// =======================
app.post('/callback', (req, res) => {
  console.log('=== STK CALLBACK RECEIVED ===');
  console.log(JSON.stringify(req.body, null, 2));

  res.json({
    ResultCode: 0,
    ResultDesc: 'Accepted'
  });
});

// =======================
// START SERVER
// =======================
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});