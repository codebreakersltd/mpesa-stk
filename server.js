const result = require('dotenv').config();

console.log("DOTENV PARSE RESULT:", result);
console.log("BUSINESS_SHORTCODE:", process.env.BUSINESS_SHORTCODE);
console.log("CALLBACK_URL:", process.env.CALLBACK_URL);

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

// 🔥 FIREBASE ADMIN
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  })
});

const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 3000;

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

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
// STK PUSH ROUTE (UPDATED)
// =======================
app.post('/stkpush', async (req, res) => {
  let { phone, amount, paymentType, referenceId } = req.body;

  try {
    if (!phone || !amount || !paymentType || !referenceId) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    // Normalize phone
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
      AccountReference: paymentType, // 👈 shows MEMBERSHIP or JERSEY
      TransactionDesc: `${paymentType} Payment`
    };

    const response = await axios.post(stkUrl, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    // 🔥 NEW: STORE STK REQUEST MAPPING
    const responseData = response.data;
    const checkoutId = responseData.CheckoutRequestID;

    await db.collection("stk_requests").doc(checkoutId).set({
      phone,
      amount,
      paymentType,
      referenceId,
      status: "PENDING",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log("✅ STK REQUEST STORED:", checkoutId);

    res.json({
      success: true,
      message: 'STK Push sent successfully',
      checkoutId,
      data: responseData
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
// CALLBACK (UNCHANGED FOR NOW)
// =======================
app.post('/callback', async (req, res) => {
  console.log('=== STK CALLBACK RECEIVED ===');
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const callback = req.body.Body.stkCallback;

    if (callback.ResultCode === 0) {

      const items = callback.CallbackMetadata.Item;

      const phone = items.find(i => i.Name === "PhoneNumber").Value;

      console.log("✅ PAID PHONE:", phone);

      await db.collection("members")
        .doc(phone.toString())
        .update({ status: "ACTIVE" });

      console.log("🔥 Firestore updated to ACTIVE");

    } else {
      console.log("❌ Payment failed:", callback.ResultDesc);
    }

    res.json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });

  } catch (error) {
    console.error("❌ CALLBACK ERROR:", error);
  }
});

// =======================
// START SERVER
// =======================
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});