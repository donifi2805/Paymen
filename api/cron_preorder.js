// File: api/cron_preorder.js (FINAL FIX: SUPPORT ARRAY & CFMX)
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

// Helper: Delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
    const { kunci } = req.query;
    if (kunci !== CRON_PASSWORD) return res.status(401).json({ error: 'Akses ditolak' });

    try {
        // Limit 12 (Batching agar tidak timeout)
        const snapshot = await db.collection('preorders')
            .orderBy('timestamp', 'asc')
            .limit(12) 
            .get();
        
        if (snapshot.empty) return res.status(200).json({ success: true, message: 'Antrian kosong.' });

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
                    // --- LOGIC ICS ---
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
                    // --- LOGIC KHFY (FIX CFMX) ---
                    const apiRes = await fetch(`${KHFY_CONFIG.baseUrl}/trx?api_key=${KHFY_CONFIG.apiKey}&kode_produk=${data.provider}&tujuan=${data.targetNumber}&reff_id=${reffId}`);
                    rawResult = await apiRes.json();

                    // 1. Normalisasi Data (Cek apakah Array?)
                    let txData = rawResult.data;
                    if (Array.isArray(txData) && txData.length > 0) {
                        txData = txData[0]; // Ambil isi pertama dari Array
                    }

                    // 2. Ambil Status Text (Cari di dalam txData dulu, baru di luar)
                    const statusText = (txData?.status_text || rawResult.message || '').toUpperCase();
                    
                    // 3. Cek Logika Sukses (Termasuk status "SUKSES" dari CFMX)
                    if ((rawResult.ok || rawResult.status) && (statusText.includes('SUKSES') || statusText.includes('PROSES'))) {
                        isSuccess = true;
                        // Ambil SN dari dalam data (Penting untuk CFMX varian)
                        sn = txData?.sn || rawResult.message || 'Proses Server Khfy';
                    }
                }
            } catch (err) {
                rawResult = { error: err.message };
            }

            if (isSuccess) {
                // SUKSES
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
                // GAGAL - Ambil Pesan Error Asli
                let realReason = 'Gagal Unknown';
                try {
                    // Logic pengambilan pesan error yang mendalam
                    let txData = rawResult?.data;
                    if (Array.isArray(txData) && txData.length > 0) txData = txData[0];

                    if (serverType === 'ICS') {
                        realReason = txData?.message || rawResult?.message || JSON.stringify(rawResult);
                    } else {
                        // Cek error dari KHFY
                        realReason = txData?.sn || txData?.keterangan || rawResult?.message || rawResult?.error || JSON.stringify(rawResult);
                    }
                } catch (e) { realReason = "Error parsing"; }

                if (typeof realReason === 'string' && realReason.length > 80) realReason = realReason.substring(0, 80) + '...';

                await db.collection('preorders').doc(poId).update({
                    debugStatus: 'RETRY', debugLogs: `[${new Date().toLocaleTimeString('id-ID')}] ${realReason}`
                });
                return { status: `GAGAL (${realReason})`, phone: data.targetNumber };
            }
        };

        // --- BATCHING (Max 4 request per detik) ---
        const BATCH_SIZE = 4;
        const allResults = [];
        const docs = snapshot.docs;

        for (let i = 0; i < docs.length; i += BATCH_SIZE) {
            const batchDocs = docs.slice(i, i + BATCH_SIZE);
            const batchPromises = batchDocs.map(doc => processSinglePreorder(doc));
            const batchResults = await Promise.all(batchPromises);
            
            allResults.push(...batchResults);

            if (i + BATCH_SIZE < docs.length) {
                await delay(1500); // Tunggu 1.5 Detik
            }
        }

        const successCount = allResults.filter(r => r.status === 'SUKSES').length;
        const failCount = allResults.length - successCount;

        return res.status(200).json({ 
            success: true, 
            mode: 'FINAL FIX (CFMX SUPPORT)',
            processed: allResults.length, 
            stats: { sukses: successCount, pending: failCount },
            logs: allResults.map(r => `${r.phone}: ${r.status}`)
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}