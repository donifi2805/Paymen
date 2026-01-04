const admin = require('firebase-admin');

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (e) {
    console.error('Firebase Admin Init Error:', e);
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
  // ICS Webhook biasanya menggunakan POST
  if (req.method !== 'POST') {
    return res.status(405).json({ status: false, msg: 'Method Not Allowed' });
  }

  // Ambil data callback dari ICS
  const { ref_id_custom, status, sn, message } = req.body;
  const refid = ref_id_custom;

  if (!refid || !status) {
    return res.status(400).json({ status: false, msg: 'Invalid Callback Data' });
  }

  try {
    // Cari transaksi di koleksi users > history (sub-collection) secara global
    const transactionsQuery = await db.collectionGroup('history')
      .where('trx_id', '==', refid)
      .limit(1)
      .get();

    if (transactionsQuery.empty) {
      return res.status(404).json({ status: false, msg: 'Transaction Not Found' });
    }

    const docSnapshot = transactionsQuery.docs[0];
    const trxRef = docSnapshot.ref;
    const trxData = docSnapshot.data();
    
    // Ambil UID dari path dokumen (users/{uid}/history/{trxid})
    const uid = trxRef.path.split('/')[1];

    // Mapping Status
    let newStatus = 'Pending';
    const statusLower = status.toLowerCase();
    
    if (statusLower === 'success' || statusLower === 'sukses') newStatus = 'Sukses';
    else if (statusLower === 'failed' || statusLower === 'gagal' || statusLower === 'error') newStatus = 'Gagal';

    // Jika sudah final, abaikan
    if (trxData.status === 'Sukses' || trxData.status === 'Gagal') {
      return res.status(200).json({ status: true, msg: 'Already Finalized' });
    }

    // Update Status Transaksi
    await trxRef.update({
      status: newStatus,
      api_msg: sn || message || (newStatus === 'Sukses' ? 'Transaksi Berhasil' : 'Transaksi Gagal'),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });

    // Logika Refund jika Gagal
    if (newStatus === 'Gagal') {
      const userRef = db.collection('users').doc(uid);
      const price = parseInt(trxData.amount);

      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) return;

        const currentBalance = userDoc.data().balance || 0;
        t.update(userRef, { balance: currentBalance + price });
      });
    }

    return res.status(200).json({ status: true, msg: 'Webhook Processed' });

  } catch (error) {
    console.error('[Webhook Error]', error);
    return res.status(500).json({ status: false, msg: 'Internal Server Error' });
  }
}