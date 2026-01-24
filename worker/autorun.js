const admin = require('firebase-admin');

// --- 1. KONFIGURASI DAN SETUP ---

// Inisialisasi Firebase
try {
    if (!admin.apps.length) {
        // Pastikan Environment Variable FIREBASE_SERVICE_ACCOUNT sudah diset di Vercel/System Anda
        // Jika testing lokal tanpa Env Var, ganti baris ini dengan require('./serviceAccount.json')
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
    apiKey: "8F1199C1-483A-4C96-825E-F5EBD33AC60A" 
};

const ICS_CONFIG = {
    baseUrl: "https://reseller.ics-store.my.id", 
    apiKey: "dcc0a69aa74abfde7b1bc5d252d858cb2fc5e32192da06a3" 
};

// Konfigurasi Telegram
const TG_TOKEN = "7850521841:AAH84wtuxnDWg5u..."; // Ganti dengan Token Bot Anda
const TG_CHAT_ID = "6369628859"; // Ganti dengan ID Admin Anda

// --- 2. FUNGSI BANTUAN (HELPER) - Menggunakan Native Fetch ---

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
    
    // Convert params to URLSearchParams (Format Form Data)
    const body = new URLSearchParams(params);

    try {
        const res = await fetch(url, { method: 'POST', body: body });
        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch {
            return { success: false, message: 'Invalid JSON', raw: text };
        }
    } catch (e) {
        return { success: false, message: e.message };
    }
}

// Fungsi Panggil API ICS
async function callIcs(action, params) {
    const url = `${ICS_CONFIG.baseUrl}/api/reseller?action=${action}`;
    params.apikey = ICS_CONFIG.apiKey;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch {
            return { success: false, message: 'Invalid JSON', raw: text };
        }
    } catch (e) {
        return { success: false, message: e.message };
    }
}

// --- 3. LOGIKA UTAMA (WORKER) ---

async function processQueue() {
    console.log(`[${new Date().toLocaleTimeString()}] Mengecek antrian...`);

    try {
        // QUERY UTAMA: Ambil data 'Pending' ATAU 'Gagal' (Retry Logic)
        const snapshot = await db.collection('preorders')
            .where('status', 'in', ['Pending', 'Gagal']) 
            .orderBy('timestamp', 'asc') // Proses yang terlama dulu
            .limit(1)
            .get();

        if (snapshot.empty) {
            console.log("Antrian kosong.");
            return;
        }

        const docSnapshot = snapshot.docs[0];
        const data = docSnapshot.data();
        const docId = docSnapshot.id;

        console.log(`Memproses: ${data.productName} -> ${data.targetNumber} (${data.serverType})`);

        // 1. Update Status jadi 'Proses' (Locking)
        await db.collection('preorders').doc(docId).update({ status: 'Proses' });

        let result = { success: false, message: 'Unknown Error', sn: '', raw: {} };
        const serverType = (data.serverType || 'KHFY').toUpperCase();
        
        // Buat ReffID Unik untuk Server
        const serverRefId = `${docId}-${Date.now()}`; 

        // 2. EKSEKUSI KE SERVER
        if (serverType === 'KHFY') {
            const apiRes = await callKhfy('/trx', {
                kode_produk: data.provider,
                no_hp: data.targetNumber,
                ref_id: serverRefId
            });
            
            result.raw = apiRes;
            // Cek sukses KHFY (status 1 = sukses, 0 = pending/proses)
            if (apiRes.data && (apiRes.data.status === 1 || apiRes.data.status === 0)) {
                result.success = true;
                result.message = apiRes.data.message || 'Transaksi Diproses';
                result.sn = apiRes.data.sn || '';
            } else {
                result.success = false;
                result.message = apiRes.message || 'Gagal KHFY';
            }

        } else if (serverType === 'ICS') {
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

        // 3. PENANGANAN HASIL
        
        if (result.success) {
            // === JIKA SUKSES ===
            console.log(`[SUKSES] ${data.targetNumber}`);

            // Update Dokumen Preorder (TIDAK DELETE) -> Pindah ke tab 'Riwayat Sukses'
            await db.collection('preorders').doc(docId).update({
                status: 'Success', 
                api_msg: result.message,
                sn: result.sn || 'Proses Server',
                raw_json: JSON.stringify(result.raw), 
                processedAt: admin.firestore.FieldValue.serverTimestamp(),
                trx_id_server: serverRefId
            });

            // Update History User
            if (data.uid && data.historyId) {
                await db.collection('users').doc(data.uid)
                    .collection('history').doc(data.historyId)
                    .update({
                        status: 'Sukses',
                        sn: result.sn || 'Sedang Diproses',
                        api_msg: result.message,
                        trx_id: serverRefId
                    });
            }

            // Notifikasi Telegram
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

            // Update status 'Gagal' -> Akan diambil lagi oleh query (Retry Loop)
            await db.collection('preorders').doc(docId).update({
                status: 'Gagal', 
                api_msg: result.message,
                raw_json: JSON.stringify(result.raw),
                lastTry: admin.firestore.FieldValue.serverTimestamp()
            });

            // Update History User (Opsional: Tetap Pending agar user sabar, atau info Gagal)
            if (data.uid && data.historyId) {
                await db.collection('users').doc(data.uid)
                    .collection('history').doc(data.historyId)
                    .update({
                        api_msg: `Percobaan Gagal: ${result.message}. Mencoba lagi...`
                    });
            }

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

console.log("Worker Autorun Berjalan (Native Fetch Mode)...");
// Loop setiap 5 detik
setInterval(processQueue, 5000);