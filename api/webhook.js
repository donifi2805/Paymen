// api/webhook.js
import admin from 'firebase-admin';

// Inisialisasi Firebase Admin
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// Regex untuk membedah pesan KH-FY
const RX = /RC=(?<reffid>[a-f0-9-]+)\s+TrxID=(?<trxid>\d+)\s+(?<produk>[A-Z0-9]+)\.(?<tujuan>\d+)\s+(?<status_text>[A-Za-z]+)\s*(?<keterangan>.+?)(?:\s+Saldo[\s\S]*?)?(?:\bresult=(?<status_code>\d+))?\s*>?$/i;

export default async function handler(req, res) {
  // KH-FY memanggil via GET dengan parameter ?message=...
  const message = req.query.message || req.body.message;

  if (!message) {
    return res.status(400).json({ ok: false, error: 'message kosong' });
  }

  try {
    const match = message.match(RX);
    if (!match || !match.groups) {
      console.log('[WEBHOOK] Format tidak dikenali:', message);
      return res.status(200).json({ ok: false, error: 'format tidak dikenali' });
    }

    const { reffid, status_text, status_code: statusCodeRaw } = match.groups;
    const keterangan = (match.groups.keterangan || '').trim();

    // Normalisasi Status Code
    let status_code = null;
    if (statusCodeRaw != null) {
      status_code = Number(statusCodeRaw);
    } else {
      if (/sukses/i.test(status_text)) status_code = 0;
      else if (/gagal|batal/i.test(status_text)) status_code = 1;
    }

    console.log(`[WEBHOOK] Memproses ReffID: ${reffid} | Status: ${status_text}`);

    // --- LOGIKA DATABASE FIRESTORE ---
    
    // Cari dokumen transaksi di koleksi 'users' -> 'history' berdasarkan reffid (trx_id)
    // Karena reffid disimpan di sub-koleksi, kita gunakan query Group atau pencarian spesifik
    const historyQuery = await db.collectionGroup('history')
      .where('trx_id', '==', reffid)
      .get();

    if (historyQuery.empty) {
      console.log('[WEBHOOK] Transaksi tidak ditemukan di Firestore:', reffid);
      return res.status(200).json({ ok: false, error: 'trx_id_not_found' });
    }

    const trxDoc = historyQuery.docs[0];
    const trxData = trxDoc.data();
    const userRef = trxDoc.ref.parent.parent; // Merujuk ke dokumen User (karena path: users/uid/history/id)

    if (status_code === 0) {
      // 1. UPDATE SUKSES
      await trxDoc.ref.update({
        status: 'Sukses',
        api_msg: keterangan || status_text
      });
      console.log('[AKSI] Firestore Updated: Sukses');

    } else if (status_code === 1) {
      // 2. PROSES REFUND JIKA GAGAL
      // Gunakan Transaction untuk memastikan konsistensi saldo
      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) return;

        const currentBalance = userDoc.data().balance || 0;
        const refundAmount = trxData.amount;

        // Tambahkan saldo kembali ke user
        t.update(userRef, { balance: currentBalance + refundAmount });
        
        // Update status history menjadi Gagal
        t.update(trxDoc.ref, {
          status: 'Gagal',
          api_msg: 'REFUND: ' + (keterangan || status_text)
        });
      });
      console.log('[AKSI] Firestore Updated: Gagal & Refund Berhasil');
    }

    return res.status(200).json({ ok: true, reffid });

  } catch (error) {
    console.error('[WEBHOOK ERROR]:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
