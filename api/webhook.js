import admin from 'firebase-admin';

// Inisialisasi Firebase Admin
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    // Mengatasi masalah karakter newline yang sering rusak di Vercel
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase Admin Berhasil Terhubung");
  } catch (e) {
    console.error("Firebase Init Error:", e.message);
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
  // KH-FY biasanya mengirim via GET ?message=...
  // Kita ambil message secara aman
  const { message } = req.query;

  if (!message) {
    return res.status(200).send("Webhook Aktif - Menunggu Laporan KH-FY");
  }

  try {
    // Regex untuk mengambil ReffID dan Status
    const RX = /RC=(?<reffid>[a-f0-9-]+)\s+TrxID=(?<trxid>\d+)\s+(?<produk>[A-Z0-9]+)\.(?<tujuan>\d+)\s+(?<status_text>[A-Za-z]+)/i;
    const match = message.match(RX);
    
    if (!match) {
      console.log("[WEBHOOK] Format pesan tidak sesuai regex:", message);
      return res.status(200).json({ ok: false, error: "Format tidak sesuai" });
    }

    const { reffid, status_text } = match.groups;
    const isSuccess = /sukses/i.test(status_text);

    console.log(`[WEBHOOK] ReffID: ${reffid} | Status: ${status_text}`);

    // Mencari transaksi di Firestore
    const snapshot = await db.collectionGroup('history')
      .where('trx_id', '==', reffid)
      .limit(1)
      .get();
    
    if (snapshot.empty) {
      console.log("[WEBHOOK] Trx ID tidak ditemukan di Firestore:", reffid);
      return res.status(200).json({ ok: false, error: "Data tidak ditemukan" });
    }

    const docTrx = snapshot.docs[0];
    const userRef = docTrx.ref.parent.parent;

    if (isSuccess) {
      // Update status menjadi Sukses
      await docTrx.ref.update({ status: 'Sukses' });
      console.log("[AKSI] Transaksi Sukses Berhasil Diupdate");
    } else {
      // Jalankan Refund jika Gagal
      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        const currentBalance = userDoc.data().balance || 0;
        const refundAmount = docTrx.data().amount || 0;

        t.update(userRef, { balance: currentBalance + refundAmount });
        t.update(docTrx.ref, { status: 'Gagal', api_msg: 'Refund Berhasil' });
      });
      console.log("[AKSI] Transaksi Gagal - Refund Telah Diproses");
    }

    return res.status(200).json({ ok: true, reffid });
  } catch (err) {
    console.error("[WEBHOOK ERROR]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
