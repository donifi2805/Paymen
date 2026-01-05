// File: api/cron_preorder.js (VERSI SMART BATCHING)
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount)
    });
}

const db = getFirestore();

// --- CONFIG ---
const KHFY_CONFIG = { apiKey: "8F1199C1-483A-4C96-825E-F5EBD33AC60A", baseUrl: "https://panel.khfy-store.com/api_v2" };
const ICS_CONFIG = { apiKey: "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77", baseUrl: "https://api.ics-store.my.id/api/reseller" };
const CRON_PASSWORD = "RAHASIA_DAPUR_PANDAWA"; 

// Helper untuk Jeda Waktu (Delay)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
    const { kunci } = req.query;
    if (kunci !== CRON_PASSWORD) return res.status(401).json({ error: 'Akses ditolak' });

    try {
        // PERUBAHAN 1: TURUNKAN LIMIT KE 12
        // Kenapa 12? Kita akan proses 4 items per detik.
        // 12 items = 3 batch x 1.5 detik = 4.5 detik (Aman untuk Vercel Free yg limit 10s)
        // Sisanya akan diproses di menit berikutnya oleh Cron Job.
        const snapshot = await db.collection('preorders')
            .orderBy('timestamp', 'asc')
            .limit(12) 
            .get();
        
        if (snapshot.empty) return res.status(200).json({ success: true, message: 'Antrian kosong.' });

        // Fungsi Proses Tunggal (Sama seperti sebelumnya)
        const processSinglePreorder = async (doc) => {
            const data = doc.data();
            const poId = doc.id;
            
            if (data.debugStatus === 'TERBELI') return { status: 'SKIP', phone: data.targetNumber };

            const serverType = data.serverType || 'KHFY';
            const reffId = `AUTO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            let isSuccess = false;
            let sn = '';
            let rawResult = null;

            try {
                if (serverType === 'ICS') {
                    const apiRes = await fetch(`${ICS_CONFIG.baseUrl}/trx?apikey=${ICS_CONFIG.apiKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            product_code: data.provider,
                            dest_number: data.targetNumber,
                            ref_id_custom: reffId
                        })
                    });
                    rawResult = await apiRes.json();
                    if (rawResult.success === true && rawResult.data?.status !== 'Gagal') {
                        isSuccess = true;
                        sn = rawResult.data.message || 'Proses Server ICS';
                    }
                } else {
                    const apiRes = await fetch(`${KHFY_CONFIG.baseUrl}/trx?api_key=${KHFY_CONFIG.apiKey}&kode_produk=${data.provider}&tujuan=${data.targetNumber}&reff_id=${reffId}`);
                    rawResult = await apiRes.json();
                    const msg = (rawResult.message || '').toLowerCase();
                    if ((rawResult.ok || rawResult.status) && (msg.includes('sukses') || msg.includes('proses'))) {
                        isSuccess = true;
                        if(rawResult.data) sn = rawResult.data.sn || rawResult.data.message || 'Proses Server Khfy';
                    }
                }
            } catch (err) {
                rawResult = { error: err.message };
            }

            if (isSuccess) {
                const historyId = data.historyId || `PO-${poId}`;
                const historyRef = db.collection('users').doc(data.uid).collection('history').doc(historyId);
                const hSnap = await historyRef.get();
                if (hSnap.exists && hSnap.data().status === 'Pending') {
                    await historyRef.update({
                        status: 'Sukses', api_msg: `Auto Run: ${sn}`, trx_id: reffId, date_updated: new Date().toISOString()
                    });
                }
                await db.collection('preorders').doc(poId).delete();
                return { status: 'SUKSES', phone: data.targetNumber };
            } else {
                let realReason = 'Gagal Unknown';
                try {
                    if (serverType === 'ICS') realReason = rawResult?.data?.message || rawResult?.message || JSON.stringify(rawResult);
                    else realReason = rawResult?.data?.sn || rawResult?.message || rawResult?.msg || rawResult?.error || JSON.stringify(rawResult);
                } catch (e) { realReason = "Error parsing"; }

                if (typeof realReason === 'string' && realReason.length > 60) realReason = realReason.substring(0, 60) + '...';

                await db.collection('preorders').doc(poId).update({
                    debugStatus: 'RETRY', debugLogs: `[${new Date().toLocaleTimeString('id-ID')}] ${realReason}`
                });
                return { status: `GAGAL (${realReason})`, phone: data.targetNumber };
            }
        };

        // --- PERUBAHAN 2: LOGIKA BATCHING (Mencicil) ---
        const BATCH_SIZE = 4; // Maksimal 4 request serentak (Sesuai Hint Error)
        const allResults = [];
        const docs = snapshot.docs;

        for (let i = 0; i < docs.length; i += BATCH_SIZE) {
            // Ambil potongan 4 data
            const batchDocs = docs.slice(i, i + BATCH_SIZE);
            
            // Jalankan 4 data ini secara parallel
            const batchPromises = batchDocs.map(doc => processSinglePreorder(doc));
            const batchResults = await Promise.all(batchPromises);
            
            allResults.push(...batchResults);

            // JIKA masih ada antrian berikutnya, tunggu 1.5 detik agar tidak kena Rate Limit
            if (i + BATCH_SIZE < docs.length) {
                await delay(1500); // Tunggu 1.5 Detik
            }
        }

        const successCount = allResults.filter(r => r.status === 'SUKSES').length;
        const failCount = allResults.length - successCount;

        return res.status(200).json({ 
            success: true, 
            mode: 'SMART BATCHING (Safe)',
            processed: allResults.length, 
            stats: { sukses: successCount, pending: failCount },
            logs: allResults.map(r => `${r.phone}: ${r.status}`)
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}