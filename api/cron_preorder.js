// File: api/cron_preorder.js (VERSI TURBO PARALLEL + REAL LOGS)
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// --- 1. SETUP FIREBASE ADMIN ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount)
    });
}

const db = getFirestore();

// --- 2. KONFIGURASI SUPPLIER ---
const KHFY_CONFIG = { 
    apiKey: "8F1199C1-483A-4C96-825E-F5EBD33AC60A", 
    baseUrl: "https://panel.khfy-store.com/api_v2" 
};
const ICS_CONFIG = { 
    apiKey: "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77", 
    baseUrl: "https://api.ics-store.my.id/api/reseller" 
};

// --- 3. PASSWORD PENGAMAN ---
const CRON_PASSWORD = "RAHASIA_DAPUR_PANDAWA"; 

export default async function handler(req, res) {
    // Cek Password
    const { kunci } = req.query;
    if (kunci !== CRON_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Akses Ditolak!' });
    }

    try {
        // UPDATE 1: Naikkan limit ke 35 karena kita pakai Parallel Processing (Lebih Cepat)
        const snapshot = await db.collection('preorders')
            .orderBy('timestamp', 'asc')
            .limit(35) 
            .get();
        
        if (snapshot.empty) {
            return res.status(200).json({ success: true, message: 'Antrian kosong.' });
        }

        // --- FUNGSI PROSES TUNGGAL (Dijalankan berbarengan nanti) ---
        const processSinglePreorder = async (doc) => {
            const data = doc.data();
            const poId = doc.id;
            
            // Safety Check
            if (data.debugStatus === 'TERBELI') return { status: 'SKIP', phone: data.targetNumber };

            const serverType = data.serverType || 'KHFY'; 
            const reffId = `AUTO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            let isSuccess = false;
            let sn = '';
            let rawResult = null; // Untuk debug error asli

            // --- EKSEKUSI API ---
            try {
                if (serverType === 'ICS') {
                    // Logic ICS
                    const icsUrl = `${ICS_CONFIG.baseUrl}/trx?apikey=${ICS_CONFIG.apiKey}`;
                    const icsBody = {
                        product_code: data.provider,
                        dest_number: data.targetNumber,
                        ref_id_custom: reffId
                    };
                    
                    const apiRes = await fetch(icsUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(icsBody)
                    });
                    const result = await apiRes.json();
                    rawResult = result;
                    
                    // Cek Sukses ICS (Pastikan tidak status Gagal)
                    if (result.success === true && result.data && result.data.status !== 'Gagal') {
                        isSuccess = true;
                        sn = result.data.message || 'Proses Server ICS';
                    }
                } else {
                    // Logic KHFY
                    const khfyUrl = `${KHFY_CONFIG.baseUrl}/trx?api_key=${KHFY_CONFIG.apiKey}&kode_produk=${data.provider}&tujuan=${data.targetNumber}&reff_id=${reffId}`;
                    const apiRes = await fetch(khfyUrl);
                    const result = await apiRes.json();
                    rawResult = result;

                    // Cek Sukses Khfy
                    const msg = (result.message || '').toLowerCase();
                    if ((result.ok || result.status) && (msg.includes('sukses') || msg.includes('proses'))) {
                        isSuccess = true;
                        if(result.data) sn = result.data.sn || result.data.message || 'Proses Server Khfy';
                    }
                }
            } catch (err) {
                // Error Koneksi/Fetch
                rawResult = { error: err.message };
            }

            // --- UPDATE DATABASE HASIL ---
            if (isSuccess) {
                // 1. SUKSES: Update User History & Hapus Preorder
                const historyId = data.historyId || `PO-${poId}`;
                const historyRef = db.collection('users').doc(data.uid).collection('history').doc(historyId);
                
                const hSnap = await historyRef.get();
                // Pastikan status user masih Pending sebelum diubah jadi Sukses
                if (hSnap.exists && hSnap.data().status === 'Pending') {
                    await historyRef.update({
                        status: 'Sukses',
                        api_msg: `Auto Run: ${sn}`,
                        trx_id: reffId,
                        date_updated: new Date().toISOString()
                    });
                }

                await db.collection('preorders').doc(poId).delete();
                return { status: 'SUKSES', phone: data.targetNumber };

            } else {
                // 2. GAGAL: UPDATE LOG ASLI (Bukan cuma "Retrying")
                let realReason = 'Gagal Unknown';
                
                // Ekstrak pesan error asli dari server pusat
                try {
                    if (serverType === 'ICS') {
                        realReason = rawResult?.data?.message || rawResult?.message || JSON.stringify(rawResult);
                    } else {
                        realReason = rawResult?.data?.sn || rawResult?.message || rawResult?.msg || JSON.stringify(rawResult);
                    }
                } catch (e) { realReason = "Error parsing response"; }

                // Potong jika terlalu panjang
                if (typeof realReason === 'string' && realReason.length > 50) realReason = realReason.substring(0, 50) + '...';

                await db.collection('preorders').doc(poId).update({
                    debugStatus: 'RETRY',
                    // Log ini akan muncul di Panel Admin Anda
                    debugLogs: `[${new Date().toLocaleTimeString('id-ID')}] ${realReason}`
                });
                
                return { status: `GAGAL (${realReason})`, phone: data.targetNumber };
            }
        };

        // --- UPDATE 2: PARALLEL EXECUTION (Promise.all) ---
        // Ini kuncinya: Menjalankan 35 proses sekaligus, bukan antri satu-satu
        const promises = snapshot.docs.map(doc => processSinglePreorder(doc));
        const results = await Promise.all(promises);

        // Hitung Statistik
        const successCount = results.filter(r => r.status === 'SUKSES').length;
        const failCount = results.length - successCount;

        return res.status(200).json({ 
            success: true, 
            mode: 'PARALLEL TURBO',
            processed: results.length, 
            stats: { sukses: successCount, pending: failCount },
            logs: results.map(r => `${r.phone}: ${r.status}`)
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}