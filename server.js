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
// STK PUSH ROUTE
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
      AccountReference: paymentType,
      TransactionDesc: `${paymentType} Payment`
    };

    const response = await axios.post(stkUrl, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const responseData = response.data;
    const checkoutId = responseData.CheckoutRequestID;

    // 🔥 store STK request
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
// CALLBACK
// =======================
app.post('/callback', async (req, res) => {

  try {
    console.log('=== STK CALLBACK RECEIVED ===');
    console.log(JSON.stringify(req.body, null, 2));

    const callback = req.body?.Body?.stkCallback;

    if (!callback) {
      console.log("❌ Invalid callback structure");
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const checkoutId = callback.CheckoutRequestID;

    const stkDoc = await db.collection("stk_requests").doc(checkoutId).get();

    if (!stkDoc.exists) {
      console.log("❌ Unknown transaction:", checkoutId);
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const { paymentType, referenceId } = stkDoc.data();

    // =========================
    // SUCCESS
    // =========================
    if (callback.ResultCode === 0) {

      const items = callback.CallbackMetadata?.Item || [];

      const getValue = (name) =>
        items.find(i => i.Name === name)?.Value;

      const receipt = getValue("MpesaReceiptNumber");
      const phone = getValue("PhoneNumber");
      const amount = getValue("Amount");

      console.log("✅ PAYMENT SUCCESS:", paymentType);

      // 🟢 MEMBERSHIP
      if (paymentType === "MEMBERSHIP") {

        await db.collection("members")
          .doc(referenceId)
          .update({
            status: "ACTIVE",
            receipt,
            paidAt: admin.firestore.FieldValue.serverTimestamp()
          });

        console.log("🔥 MEMBERSHIP ACTIVATED:", referenceId);
      }

      // 🔵 JERSEY ORDERS
      else if (paymentType === "JERSEY") {

        await db.collection("orders")
          .doc(referenceId)
          .update({
            status: "PAID",
            receipt,
            phone: phone || "",
            amount: amount || 0,
            paidAt: admin.firestore.FieldValue.serverTimestamp()
          });

        console.log("🔥 ORDER PAID:", referenceId);
      }

      await db.collection("stk_requests")
        .doc(checkoutId)
        .update({ status: "SUCCESS" });

    }

    // =========================
    // FAILED
    // =========================
    else {

      console.log("❌ PAYMENT FAILED:", callback.ResultDesc);

      await db.collection("stk_requests")
        .doc(checkoutId)
        .update({ status: "FAILED" });

      if (paymentType === "JERSEY") {
        await db.collection("orders")
          .doc(referenceId)
          .update({ status: "FAILED" });
      }
    }

    res.json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });

  } catch (error) {
    console.error("❌ CALLBACK ERROR:", error);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// =======================
// START SERVER
// =======================
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});