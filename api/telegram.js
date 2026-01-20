// api/telegram.js
import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';

// --- KONFIGURASI ---
const token = '8576099469:AAHxURiNMnVhWdLqHLlAoX7ayAVX6HsCSiY';
// Ganti dengan URL domain Anda sendiri agar bot bisa menembak API Relay internal
const BASE_URL = 'https://www.pandawa-digital.store'; 

const firebaseConfig = {
    apiKey: "AIzaSyBnVxgxkS8InH1PQCMGe3cY8IvPqSN6dLo",
    authDomain: "ppob-3ea96.firebaseapp.com",
    projectId: "ppob-3ea96"
};

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
    : null;

const ALLOWED_ADMINS = ['doni888855519@gmail.com', 'suwarno8797@gmail.com'];

// --- MENU BARU KHUSUS PREORDER ---
const mainMenu = {
    resize_keyboard: true,
    one_time_keyboard: false,
    keyboard: [
        [{ text: "🚀 RUN AUTO MASSAL" }],
        [{ text: "📋 Cek Antrian Preorder" }],
        [{ text: "🚪 Logout" }]
    ]
};

// --- INISIALISASI ---
if (!admin.apps.length) {
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
}
const db = admin.firestore();
const clientApp = initializeApp(firebaseConfig, 'clientBotApp');
const clientAuth = getAuth(clientApp);

const formatRp = (n) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n);

// --- HELPER: EXECUTE TRANSACTION VIA RELAY ---
async function executeTransaction(poData) {
    const { targetNumber, provider, serverType, id } = poData;
    const reffId = `BOT-${Date.now()}-${id.substring(0,4)}`;
    
    try {
        let url = '';
        if (serverType === 'KHFY') {
            url = `${BASE_URL}/api/relaykhfy?endpoint=/trx&produk=${provider}&tujuan=${targetNumber}&reff_id=${reffId}`;
        } else {
            // Default ICS
            let icsType = 'xda';
            if(String(provider).toUpperCase().startsWith('XCL')) icsType = 'circle';
            else if(String(provider).toUpperCase().startsWith('XLA')) icsType = 'xla';
            
            url = `${BASE_URL}/api/relay?action=createTransaction&apikey=7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77&kode_produk=${provider}&nomor_tujuan=${targetNumber}&refid=${reffId}&type=${icsType}`;
        }

        const res = await fetch(url);
        const json = await res.json();
        
        // Cek Keberhasilan berdasarkan Server
        let isSuccess = false;
        let sn = 'Proses Bot';
        
        if (serverType === 'KHFY') {
            const msg = (json.message || json.msg || '').toLowerCase();
            isSuccess = (json.status === true || json.ok === true || msg.includes('sukses') || msg.includes('proses'));
            if(json.data && json.data.message) sn = json.data.message;
        } else {
            isSuccess = json.success === true;
            if(json.data && json.data.message) sn = json.data.message;
        }

        return { success: isSuccess, sn: sn, raw: json };
    } catch (e) {
        return { success: false, sn: e.message, raw: null };
    }
}

// --- HANDLER UTAMA ---
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if (!serviceAccount) return res.status(500).send('Service Account Missing');

    const bot = new TelegramBot(token);
    const body = req.body;

    // A. HANDLE CALLBACK QUERY (TOMBOL MANUAL)
    if (body.callback_query) {
        const query = body.callback_query;
        const chatId = query.message.chat.id;
        const data = query.data; 
        
        const sessionRef = db.collection('bot_sessions').doc(String(chatId));
        const sessionSnap = await sessionRef.get();
        if (!sessionSnap.exists || !sessionSnap.data().isLoggedIn) {
            await bot.answerCallbackQuery(query.id, { text: "Sesi habis." });
            return res.status(200).send('OK');
        }

        const [action, poId] = data.split('__'); // Menggunakan separator double underscore

        try {
            const poRef = db.collection('preorders').doc(poId);
            const poSnap = await poRef.get();
            
            if (!poSnap.exists) {
                await bot.answerCallbackQuery(query.id, { text: "Data sudah hilang/terhapus." });
                return res.status(200).send('OK');
            }
            
            const poData = poSnap.data();
            const uid = poData.uid;
            const historyId = poData.historyId || ("PO-" + poId);

            if (action === 'MANUAL_ACC') {
                // FORCE SUKSES
                await db.runTransaction(async (t) => {
                    const hRef = db.collection('users').doc(uid).collection('history').doc(historyId);
                    const hDoc = await t.get(hRef);
                    if(hDoc.exists && hDoc.data().status !== 'Pending') throw "Status bukan Pending!";
                    
                    t.update(hRef, {
                        status: 'Sukses',
                        api_msg: 'Diterima Manual (Bot)',
                        date_updated: new Date().toISOString()
                    });
                    t.delete(poRef); // Hapus dari antrian preorder
                });
                await bot.sendMessage(chatId, `✅ Antrian ${poData.targetNumber} di-SET SUKSES.`);
            } 
            else if (action === 'MANUAL_REJ') {
                // MANUAL TOLAK (REFUND)
                await db.runTransaction(async (t) => {
                    const uRef = db.collection('users').doc(uid);
                    const hRef = uRef.collection('history').doc(historyId);
                    
                    const uDoc = await t.get(uRef);
                    const hDoc = await t.get(hRef);
                    
                    if(hDoc.exists && hDoc.data().status !== 'Pending') throw "Status bukan Pending!";

                    const refundAmount = poData.price || 0;
                    const newBal = (uDoc.data().balance || 0) + refundAmount;

                    t.update(uRef, { balance: newBal });
                    t.update(hRef, {
                        status: 'Gagal',
                        api_msg: 'Ditolak Manual (Bot) - Refund',
                        balance_final: newBal,
                        date_updated: new Date().toISOString()
                    });
                    t.delete(poRef); // Hapus dari antrian
                });
                await bot.sendMessage(chatId, `❌ Antrian ${poData.targetNumber} DITOLAK (Refund Rp ${refundAmount}).`);
            }
            
            // Hapus tombol setelah diklik
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            await bot.answerCallbackQuery(query.id);

        } catch (e) {
            await bot.sendMessage(chatId, `⚠️ Gagal: ${e.message || e}`);
        }
        return res.status(200).send('OK');
    }

    // B. HANDLE PESAN TEKS
    if (!body.message || !body.message.text) return res.status(200).send('OK');

    const chatId = body.message.chat.id;
    const text = body.message.text;
    const msgId = body.message.message_id;

    const sessionRef = db.collection('bot_sessions').doc(String(chatId));
    const sessionSnap = await sessionRef.get();
    const session = sessionSnap.exists ? sessionSnap.data() : { isLoggedIn: false };

    try {
        // LOGIN & LOGOUT (Sama seperti sebelumnya)
        if (text === '/logout' || text === '🚪 Logout') {
            await sessionRef.delete();
            await bot.sendMessage(chatId, "👋 Logout berhasil.", { reply_markup: { remove_keyboard: true } });
            return res.status(200).send('OK');
        }
        
        if (text === '/start') {
            if (session.isLoggedIn) {
                await bot.sendMessage(chatId, `⚙️ *PANEL DEBUG PREORDER*\nMode: Auto Run & Manual Control`, { parse_mode: 'Markdown', reply_markup: mainMenu });
            } else {
                await bot.sendMessage(chatId, `🔐 *LOGIN DEBUGGER*\nFormat: \`/login email password\``, { parse_mode: 'Markdown' });
            }
        }
        else if (text.startsWith('/login')) {
            const parts = text.split(' ');
            if (parts.length !== 3) {
                await bot.sendMessage(chatId, "❌ Format salah.");
            } else {
                const email = parts[1];
                const password = parts[2];
                try { await bot.deleteMessage(chatId, msgId); } catch(e){}

                if (!ALLOWED_ADMINS.includes(email)) {
                    await bot.sendMessage(chatId, "⛔ Akses Ditolak.");
                    return res.status(200).send('OK');
                }
                try {
                    await signInWithEmailAndPassword(clientAuth, email, password);
                    await sessionRef.set({ isLoggedIn: true, email: email });
                    await bot.sendMessage(chatId, `✅ *Siap Debugging!*`, { parse_mode: 'Markdown', reply_markup: mainMenu });
                } catch (error) {
                    await bot.sendMessage(chatId, `❌ Password salah.`);
                }
            }
        }

        else if (!session.isLoggedIn) {
            await bot.sendMessage(chatId, "🔒 Login dulu bos.");
        }

        // --- MENU 1: RUN AUTO MASSAL ---
        else if (text === '🚀 RUN AUTO MASSAL') {
            await bot.sendMessage(chatId, "🔄 Sedang memproses antrian massal (Max 5 per batch)...");
            
            // Ambil Preorder Pending
            const poSnap = await db.collection('preorders')
                .orderBy('timestamp', 'desc')
                .limit(5) // Limit agar Vercel tidak timeout
                .get();

            if (poSnap.empty) {
                await bot.sendMessage(chatId, "✅ Antrian Kosong / Bersih.");
            } else {
                let successCount = 0;
                let failCount = 0;
                let report = "📝 <b>Laporan Run Massal:</b>\n\n";

                // Loop Eksekusi
                for (const doc of poSnap.docs) {
                    const d = doc.data();
                    // Skip jika status debugnya sudah terbeli (tapi belum dihapus)
                    if (d.debugStatus === 'TERBELI') continue;

                    const result = await executeTransaction({ ...d, id: doc.id });
                    
                    if (result.success) {
                        successCount++;
                        // Update Preorder jadi TERBELI (Mirip logic paneladmin)
                        // Update History jadi Sukses
                        await db.runTransaction(async (t) => {
                            // Update History User
                            const hRef = db.collection('users').doc(d.uid).collection('history').doc(d.historyId || "PO-"+doc.id);
                            const hDoc = await t.get(hRef);
                            if(hDoc.exists) {
                                t.update(hRef, { 
                                    status: 'Sukses', 
                                    api_msg: 'Sukses by Bot Massal: ' + result.sn,
                                    date_updated: new Date().toISOString()
                                });
                            }
                            // Hapus Preorder karena sudah sukses
                            t.delete(doc.ref);
                        });
                        report += `✅ ${d.targetNumber} : Sukses\n`;
                    } else {
                        failCount++;
                        // Update Status Preorder jadi Gagal (Biar admin tau) tapi jangan hapus dulu (biar bisa manual)
                        await doc.ref.update({ 
                            debugStatus: 'GAGAL',
                            debugLogs: `Bot Try: ${result.sn}\nRaw: ${JSON.stringify(result.raw)}`
                        });
                        report += `❌ ${d.targetNumber} : Gagal (${result.sn})\n`;
                    }
                }

                await bot.sendMessage(chatId, report + `\nTotal Sukses: ${successCount}\nGagal/Skip: ${failCount}`, { parse_mode: 'HTML', reply_markup: mainMenu });
            }
        }

        // --- MENU 2: CEK ANTRIAN & KONTROL MANUAL ---
        else if (text === '📋 Cek Antrian Preorder') {
            const poSnap = await db.collection('preorders')
                .orderBy('timestamp', 'desc')
                .limit(10)
                .get();

            if (poSnap.empty) {
                await bot.sendMessage(chatId, "✅ Tidak ada antrian preorder.", { reply_markup: mainMenu });
            } else {
                for (const doc of poSnap.docs) {
                    const d = doc.data();
                    const status = d.debugStatus === 'GAGAL' ? '🔴 GAGAL' : '🟡 PENDING';
                    
                    const msg = `<b>${status}</b>\n` +
                                `User: <code>${d.username}</code>\n` +
                                `Target: <code>${d.targetNumber}</code>\n` +
                                `Produk: ${d.provider} (${d.serverType || 'KHFY'})\n` +
                                `Logs: ${d.debugLogs ? 'Ada Log Error' : '-'}`;

                    // Tombol Kontrol Manual
                    const buttons = [
                        [
                            { text: "✅ Terima (Manual Sukses)", callback_data: `MANUAL_ACC__${doc.id}` },
                            { text: "❌ Tolak (Refund)", callback_data: `MANUAL_REJ__${doc.id}` }
                        ]
                    ];

                    await bot.sendMessage(chatId, msg, {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: buttons }
                    });
                }
                await bot.sendMessage(chatId, "👆 Klik tombol di atas untuk eksekusi manual.", { reply_markup: mainMenu });
            }
        }

    } catch (error) {
        console.error("Bot Error:", error);
        await bot.sendMessage(chatId, "⚠️ Error: " + error.message);
    }

    return res.status(200).send('OK');
}