import admin from 'firebase-admin';

// Inisialisasi Firebase Admin dengan penanganan error string JSON
if (!admin.apps.length) {
  try {
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    
    // Perbaikan otomatis jika ada karakter \n yang tertulis sebagai string
    const serviceAccount = JSON.parse(serviceAccountRaw);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase Admin Berhasil Diinisialisasi");
  } catch (error) {
    console.error("Gagal Inisialisasi Firebase:", error.message);
  }
}

const db = admin.firestore();

// Regex fleksibel untuk menangkap data dari pesan KH-FY
const RX = /RC=(?<reffid>[a-f0-9-]+)\s+TrxID=(?<trxid>\d+)\s+(?<produk>[A-Z0-9]+)\.(?<tujuan>\d+)\s+(?<status_text>[A-Za-z]+)\s*(?<keterangan>.+?)(?:\s+Saldo[\s\S]*?)?(?:\bresult=(?<status_code>\d+))?\s*>?$/i;

export default async function handler(req, res) {
  // Menggunakan URL API terbaru agar tidak muncul Deprecation Warning
  const fullUrl = new URL(req.url, `https://${req.headers.host}`);
  const message = fullUrl.searchParams.get('message') || req.body?.message;

  if (!message) {
    console.log("[WEBHOOK] Request masuk tanpa pesan");
    return res.status(400).json({ ok: false, error: 'message kosong' });
  }

  try {
    const match = message.match(RX);
    if (!match || !match.groups) {
      console.log('[WEBHOOK] Format pesan tidak dikenal:', message);
      return res.status(200).json({ ok: false, error: 'format tidak dikenali' });
    }

    const { reffid, status_text, status_code: statusCodeRaw } = match.groups;
    const keterangan = (match.groups.keterangan || '').trim();

    // Penentuan Status Code
    let status_code = null;
    if (statusCodeRaw != null) {
      status_code = Number(statusCodeRaw);
    } else {
      if (/sukses/i.test(status_text)) status_code = 0;
      else if (/gagal|batal/i.test(status_text)) status_code = 1;
    }

    console.log(`[WEBHOOK] Memproses ReffID: ${reffid} | Status Raw: ${status_text}`);

    // Mencari transaksi di semua sub-koleksi 'history'
    const historyQuery = await db.collectionGroup('history')
      .where('trx_id', '==', reffid)
      .limit(1)
      .get();

    if (historyQuery.empty) {
      console.log('[WEBHOOK] ReffID tidak terdaftar di database:', reffid);
      return res.status(200).json({ ok: false, error: 'trx_id_not_found' });
    }

    const trxDoc = historyQuery.docs[0];
    const trxData = trxDoc.data();
    const userRef = trxDoc.ref.parent.parent;

    if (status_code === 0) {
      // AKSI SUKSES
      await trxDoc.ref.update({
        status: 'Sukses',
        api_msg: keterangan || status_text
      });
      console.log(`[SUKSES] ${reffid} telah diupdate ke database.`);

    } else if (status_code === 1) {
      // AKSI GAGAL & REFUND
      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) return;

        const currentBalance = userDoc.data().balance || 0;
        const refundAmount = trxData.amount;

        t.update(userRef, { balance: currentBalance + refundAmount });
        t.update(trxDoc.ref, {
          status: 'Gagal',
          api_msg: 'REFUND OTOMATIS: ' + (keterangan || status_text)
        });
      });
      console.log(`[REFUND] ${reffid} gagal, saldo dikembalikan ke user.`);
    }

    return res.status(200).json({ ok: true, reffid });

  } catch (error) {
    console.error('[WEBHOOK ERROR]:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
