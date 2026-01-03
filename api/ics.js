const admin = require('firebase-admin');

// Inisialisasi Firebase Admin (jika belum)
// Pastikan Environment Variable FIREBASE_SERVICE_ACCOUNT sudah di-set di Vercel
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
  // Hanya menerima method POST dari ICS
  if (req.method !== 'POST') {
    return res.status(405).json({ status: false, msg: 'Method Not Allowed' });
  }

  const { id, refid, status, message, sn } = req.body;

  // Validasi data dasar
  if (!refid || !status) {
    return res.status(400).json({ status: false, msg: 'Bad Request' });
  }

  console.log(`[ICS Webhook] RefID: ${refid}, Status: ${status}, SN: ${sn}`);

  try {
    // 1. Cari transaksi berdasarkan Order ID (refid di ICS = orderId di Database kita)
    const transactionQuery = await db.collection('transactions').where('orderId', '==', refid).limit(1).get();

    if (transactionQuery.empty) {
      return res.status(404).json({ status: false, msg: 'Trx Not Found' });
    }

    const docSnapshot = transactionQuery.docs[0];
    const trxData = docSnapshot.data();
    const trxId = docSnapshot.id;
    const uid = trxData.uid;
    const price = parseInt(trxData.price);

    // 2. Cek apakah status perlu diupdate
    // Mapping status ICS: 'Sukses', 'Gagal', 'Pending'
    let newStatus = 'Pending';
    if (status.toLowerCase() === 'sukses') newStatus = 'Success';
    else if (status.toLowerCase() === 'gagal') newStatus = 'Failed';
    else return res.status(200).json({ status: true, msg: 'Ignored status' });

    // Jika status di DB sudah final (Success/Failed), jangan ubah lagi
    if (trxData.status === 'Success' || trxData.status === 'Failed') {
      return res.status(200).json({ status: true, msg: 'Transaction already finalized' });
    }

    // 3. Update Status Transaksi & Masukkan SN
    await db.collection('transactions').doc(trxId).update({
      status: newStatus,
      sn: sn || trxData.sn || '-',
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4. LOGIKA REFUND OTOMATIS
    // Jika status GAGAL, kembalikan saldo ke user
    if (newStatus === 'Failed') {
      const userRef = db.collection('users').doc(uid);
      
      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) return;

        // Refund saldo
        const currentSaldo = userDoc.data().saldo || 0;
        t.update(userRef, { 
            saldo: currentSaldo + price 
        });

        // Catat di mutasi saldo (Opsional, sesuaikan dengan struktur DB Anda)
        const mutasiRef = db.collection('mutasi').doc();
        t.set(mutasiRef, {
            uid: uid,
            type: 'refund', // kredit
            amount: price,
            desc: `Refund Gagal Transaksi #${refid}`,
            date: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      console.log(`[ICS Refund] Refunded ${price} to user ${uid}`);
    }

    return res.status(200).json({ status: true, msg: 'Callback processed' });

  } catch (error) {
    console.error('[ICS Error]', error);
    return res.status(500).json({ status: false, msg: 'Internal Server Error' });
  }
}
