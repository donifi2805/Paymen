const admin = require('firebase-admin');
const fetch = require('node-fetch'); // Pastikan package ini ada di package.json

// --- 1. KONFIGURASI DAN SETUP ---

// Inisialisasi Firebase
try {
    if (!admin.apps.length) {
        // Menggunakan Environment Variable (Disarankan untuk Vercel)
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
} catch (error) {
    console.error("GAGAL SETUP FIREBASE:", error.message);
    process.exit(1);
}

const db = admin.firestore();

// Konfigurasi API Server
const KHFY_CONFIG = {
    baseUrl: "https://panel.khfy-store.com/api_v2",
    apiKey: "8F1199C1-483A-4C96-825E-F5EBD33AC60A" // Ganti jika berubah
};

const ICS_CONFIG = {
    baseUrl: "https://reseller.ics-store.my.id", // Sesuaikan base URL ICS
    apiKey: "dcc0a69aa74abfde7b1bc5d252d858cb2fc5e32192da06a3" // Ganti jika berubah
};

// Konfigurasi Telegram (Untuk Laporan Bot)
const TG_TOKEN = "7850521841:AAH84wtuxnDWg5u..."; // Masukkan Token Bot Anda
const TG_CHAT_ID = "6369628859"; // Masukkan ID Admin Anda

// --- 2. FUNGSI BANTUAN (HELPER) ---

// Fungsi Kirim Log ke Telegram
async function sendTelegramLog(message) {
    try {
        const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            })
        });
    } catch (e) {
        console.error("Gagal kirim Telegram:", e.message);
    }
}

// Fungsi Panggil API KHFY
async function callKhfy(endpoint, params) {
    const url = `${KHFY_CONFIG.baseUrl}${endpoint}`;
    params.api_key = KHFY_CONFIG.apiKey;
    
    // Convert params to Form Data / Query String
    const body = new URLSearchParams(params);

    try {
        const res = await fetch(url, { method: 'POST', body: body });
        const json = await res.json();
        return json;
    } catch (e) {
        return { success: false, message: e.message };
    }
}

// Fungsi Panggil API ICS
async function callIcs(action, params) {
    // Sesuaikan format request ICS (biasanya JSON body atau GET query)
    const url = `${ICS_CONFIG.baseUrl}/api/reseller?action=${action}`;
    params.apikey = ICS_CONFIG.apiKey; // Sesuaikan parameter auth ICS

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const json = await res.json();
        return json;
    } catch (e) {
        return { success: false, message: e.message };
    }
}

// --- 3. LOGIKA UTAMA (WORKER) ---

async function processQueue() {
    console.log(`[${new Date().toLocaleTimeString()}] Mengecek antrian...`);

    try {
        // QUERY UTAMA:
        // Ambil data yang statusnya 'Pending' ATAU 'Gagal' (Retry Logic)
        // Kita limit 1 per putaran agar tidak spamming server jika loop cepat
        const snapshot = await db.collection('preorders')
            .where('status', 'in', ['Pending', 'Gagal']) 
            .orderBy('timestamp', 'asc') // Proses yang terlama dulu
            .limit(1)
            .get();

        if (snapshot.empty) {
            console.log("Antrian kosong.");
            return;
        }

        const doc = snapshot.docs[0];
        const data = doc.data();
        const docId = doc.id;

        console.log(`Memproses: ${data.productName} -> ${data.targetNumber} (${data.serverType})`);

        // 1. Update Status jadi 'Proses' agar tidak diambil worker lain (jika ada multi-worker)
        await db.collection('preorders').doc(docId).update({ status: 'Proses' });

        let result = { success: false, message: 'Unknown Error', sn: '', raw: {} };
        const serverType = (data.serverType || 'KHFY').toUpperCase();
        
        // Buat ReffID Unik untuk Transaksi Server
        const serverRefId = `${docId}-${Date.now()}`; 

        // 2. EKSEKUSI KE SERVER
        if (serverType === 'KHFY') {
            const apiRes = await callKhfy('/trx', {
                kode_produk: data.provider, // Kode produk dari DB Preorder
                no_hp: data.targetNumber,
                ref_id: serverRefId
            });
            
            result.raw = apiRes;
            // Cek respon KHFY (Sesuaikan dengan format sukses KHFY)
            if (apiRes.data && (apiRes.data.status === 1 || apiRes.data.status === 0)) {
                result.success = true;
                result.message = apiRes.data.message || 'Transaksi Diproses';
                result.sn = apiRes.data.sn || '';
            } else {
                result.success = false;
                result.message = apiRes.message || 'Gagal KHFY';
            }

        } else if (serverType === 'ICS') {
            // Logika ICS (Contoh menggunakan endpoint order)
            const apiRes = await callIcs('order', {
                service: data.provider,
                target: data.targetNumber,
                custom_ref_id: serverRefId
            });

            result.raw = apiRes;
            if (apiRes.status === true || apiRes.success === true) {
                result.success = true;
                result.message = apiRes.msg || 'Transaksi ICS Berhasil';
                result.sn = apiRes.data ? apiRes.data.sn : '';
            } else {
                result.success = false;
                result.message = apiRes.msg || 'Gagal ICS';
            }
        }

        // 3. PENANGANAN HASIL (SUKSES / GAGAL)
        
        if (result.success) {
            // === JIKA SUKSES ===
            console.log(`[SUKSES] ${data.targetNumber}`);

            // A. Update Dokumen Preorder (JANGAN DELETE)
            await db.collection('preorders').doc(docId).update({
                status: 'Success', // Ubah status jadi Success agar keluar dari antrian 'Pending'
                api_msg: result.message,
                sn: result.sn || 'Proses Server',
                raw_json: JSON.stringify(result.raw), // Simpan JSON mentah
                processedAt: admin.firestore.FieldValue.serverTimestamp(),
                trx_id_server: serverRefId
            });

            // B. Update Riwayat User (History)
            if (data.uid && data.historyId) {
                await db.collection('users').doc(data.uid)
                    .collection('history').doc(data.historyId)
                    .update({
                        status: 'Sukses',
                        sn: result.sn || 'Sedang Diproses',
                        api_msg: result.message,
                        trx_id: serverRefId // Simpan ref id server buat cek status nanti
                    });
            }

            // C. Notifikasi Telegram Sukses
            await sendTelegramLog(
                `✅ <b>TRANSAKSI SUKSES (AUTORUN)</b>\n` +
                `Product: ${data.productName}\n` +
                `Tujuan: ${data.targetNumber}\n` +
                `Server: ${serverType}\n` +
                `Msg: ${result.message}`
            );

        } else {
            // === JIKA GAGAL ===
            console.log(`[GAGAL] ${data.targetNumber} - ${result.message}`);

            // A. Update Dokumen Preorder (TETAPKAN AGAR BISA DI-RETRY)
            // Kita ubah status jadi 'Gagal'. Karena query worker mengambil 'Pending' DAN 'Gagal',
            // maka data ini akan diambil lagi di putaran berikutnya (Retry Loop).
            await db.collection('preorders').doc(docId).update({
                status: 'Gagal', 
                api_msg: result.message, // Alasan gagal
                raw_json: JSON.stringify(result.raw),
                lastTry: admin.firestore.FieldValue.serverTimestamp()
            });

            // Opsional: Jangan update history user jadi Gagal dulu, biarkan Pending
            // agar user tau admin sedang berusaha. Atau update pesan error saja.
            if (data.uid && data.historyId) {
                await db.collection('users').doc(data.uid)
                    .collection('history').doc(data.historyId)
                    .update({
                        api_msg: `Percobaan Gagal: ${result.message}. Mencoba lagi...`
                    });
            }

            // B. Notifikasi Telegram Gagal
            await sendTelegramLog(
                `⚠️ <b>TRANSAKSI GAGAL (AKAN RETRY)</b>\n` +
                `Product: ${data.productName}\n` +
                `Tujuan: ${data.targetNumber}\n` +
                `Server: ${serverType}\n` +
                `Error: ${result.message}`
            );
        }

    } catch (error) {
        console.error("CRITICAL WORKER ERROR:", error);
    }
}

// --- 4. EKSEKUSI ---

// Jika ini dijalankan sebagai Script Standalone (bukan API Vercel)
// Gunakan setInterval untuk mengecek terus menerus
console.log("Worker Autorun Berjalan...");
setInterval(processQueue, 5000); // Cek antrian setiap 5 detik

// Jika di-deploy sebagai Vercel Function, gunakan export default handler
/*
export default async function handler(req, res) {
    await processQueue();
    res.status(200).json({ status: 'Worker Run Completed' });
}
*/