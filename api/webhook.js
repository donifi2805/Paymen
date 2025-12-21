import admin from 'firebase-admin';

if (!admin.apps.length) {
  try {
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountRaw) throw new Error("Environment Variable FIREBASE_SERVICE_ACCOUNT tidak ditemukan");
    
    const serviceAccount = JSON.parse(serviceAccountRaw);
    if (serviceAccount.private_key) {
      // Memperbaiki format private key yang sering rusak saat di-paste ke Vercel
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase Admin Initialized");
  } catch (error) {
    console.error("Firebase Init Error:", error.message);
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
  // Mengambil pesan dari query string (?message=...)
  const message = req.query.message || req.body?.message;

  if (!message) {
    return res.status(200).send("Webhook Pandawa Store Aktif");
  }

  try {
    // Regex untuk membedah laporan KH-FY
    const RX = /RC=(?<reffid>[a-f0-9-]+)\s+TrxID=(?<trxid>\d+)\s+(?<produk>[A-Z0-9]+)\.(?<tujuan>\d+)\s+(?<status_text>[A-Za-z]+)/i;
    const match = message.match(RX);
    
    if (!match) {
      console.log("[WEBHOOK] Format tidak dikenali:", message);
      return res.status(200).json({ ok: false, error: "Format tidak sesuai" });
    }

    const { reffid, status_text } = match.groups;
    const isSuccess = /sukses/i.test(status_text);

    console.log(`[WEBHOOK] Memproses ReffID: ${reffid} | Status: ${status_text}`);

    // Cari transaksi di Firestore menggunakan Collection Group
    const snapshot = await db.collectionGroup('history')
      .where('trx_id', '==', reffid)
      .limit(1)
      .get();
    
    if (snapshot.empty) {
      console.log("[WEBHOOK] ReffID tidak ditemukan di DB:", reffid);
      return res.status(200).json({ ok: false, error: "Trx ID tidak ditemukan" });
    }

    const doc = snapshot.docs[0];
    const userRef = doc.ref.parent.parent;

    if (isSuccess) {
      await doc.ref.update({ status: 'Sukses' });
      console.log("[AKSI] Status diupdate ke SUKSES");
    } else {
      // Logika Refund jika gagal
      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        const currentBalance = userDoc.data().balance || 0;
        const refundAmount = doc.data().amount || 0;

        t.update(userRef, { balance: currentBalance + refundAmount });
        t.update(doc.ref, { status: 'Gagal', api_msg: 'Refund Otomatis (Provider Gagal)' });
      });
      console.log("[AKSI] Status diupdate ke GAGAL & Refund Berhasil");
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[WEBHOOK ERROR]:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
