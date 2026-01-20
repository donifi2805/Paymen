// api/telegram.js
import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';

// --- KONFIGURASI ---
const token = '8576099469:AAHxURiNMnVhWdLqHLlAoX7ayAVX6HsCSiY';
const BASE_URL = 'https://www.pandawa-digital.store'; 

// URL File Tampilan Login (Pastikan file ini ada di hosting/github anda)
const WEB_APP_URL = `${BASE_URL}/bot-login.html`;

const firebaseConfig = {
    apiKey: "AIzaSyBnVxgxkS8InH1PQCMGe3cY8IvPqSN6dLo",
    authDomain: "ppob-3ea96.firebaseapp.com",
    projectId: "ppob-3ea96"
};

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
    : null;

const ALLOWED_ADMINS = ['doni888855519@gmail.com', 'suwarno8797@gmail.com'];

// Menu Utama
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

// --- FUNGSI EKSEKUSI TRANSAKSI ---
async function executeTransaction(poData) {
    const { targetNumber, provider, serverType, id } = poData;
    const reffId = `BOT-${Date.now()}-${id.substring(0,4)}`;
    try {
        let url = '';
        if (serverType === 'KHFY') {
            url = `${BASE_URL}/api/relaykhfy?endpoint=/trx&produk=${provider}&tujuan=${targetNumber}&reff_id=${reffId}`;
        } else {
            let icsType = 'xda';
            if(String(provider).toUpperCase().startsWith('XCL')) icsType = 'circle';
            else if(String(provider).toUpperCase().startsWith('XLA')) icsType = 'xla';
            url = `${BASE_URL}/api/relay?action=createTransaction&apikey=7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77&kode_produk=${provider}&nomor_tujuan=${targetNumber}&refid=${reffId}&type=${icsType}`;
        }
        const res = await fetch(url);
        const json = await res.json();
        
        // Logika penangkapan pesan error yang lebih detail
        let sn = json.message || json.msg || 'Gagal'; 
        if (json.data) {
            if (json.data.message) sn = json.data.message;
            else if (json.data.sn) sn = json.data.sn;
            else if (json.data.note) sn = json.data.note;
        }

        let isSuccess = false;
        if (serverType === 'KHFY') {
            const msg = (json.message || json.msg || '').toLowerCase();
            isSuccess = (json.status === true || json.ok === true || msg.includes('sukses') || msg.includes('proses'));
        } else {
            isSuccess = json.success === true;
        }
        return { success: isSuccess, sn: sn, raw: json };
    } catch (e) {
        return { success: false, sn: "Error Koneksi: " + e.message, raw: null };
    }
}

// --- HANDLER UTAMA ---
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if (!serviceAccount) return res.status(500).send('Service Account Missing');

    const bot = new TelegramBot(token);
    const body = req.body;

    // 1. HANDLE LOGIN DATA (WEB APP)
    if (body.message && body.message.web_app_data) {
        const chatId = body.message.chat.id;
        const sessionRef = db.collection('bot_sessions').doc(String(chatId));
        try {
            const data = JSON.parse(body.message.web_app_data.data);
            if (data.action === 'login_request') {
                const { email, password } = data;
                if (!ALLOWED_ADMINS.includes(email)) {
                    await bot.sendMessage(chatId, "⛔ Email tidak terdaftar sebagai Admin.");
                    return res.status(200).send('OK');
                }
                await signInWithEmailAndPassword(clientAuth, email, password);
                await sessionRef.set({ isLoggedIn: true, email: email, loginAt: new Date().toISOString() });
                await bot.sendMessage(chatId, `✅ <b>Login Berhasil!</b>\nUser: ${email}`, { parse_mode: 'HTML', reply_markup: mainMenu });
            }
        } catch (e) { await bot.sendMessage(chatId, "❌ Login Gagal: Password salah."); }
        return res.status(200).send('OK');
    }

    // 2. HANDLE TOMBOL CALLBACK
    if (body.callback_query) {
        const query = body.callback_query;
        const chatId = query.message.chat.id;
        const data = query.data;
        const [action, poId] = data.split('__');

        const sessionRef = db.collection('bot_sessions').doc(String(chatId));
        const sessionSnap = await sessionRef.get();
        if (!sessionSnap.exists || !sessionSnap.data().isLoggedIn) {
            await bot.answerCallbackQuery(query.id, { text: "Sesi habis." }); return res.status(200).send('OK');
        }

        try {
            const poRef = db.collection('preorders').doc(poId);
            const poSnap = await poRef.get();
            if (!poSnap.exists) { 
                await bot.answerCallbackQuery(query.id, { text: "Data hilang." });
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
                return res.status(200).send('OK');
            }

            const d = poSnap.data();
            const uid = d.uid;
            const historyId = d.historyId || "PO-"+poId;

            if (action === 'RUN_SINGLE') {
                await bot.sendMessage(chatId, `🔄 Menembak ${d.targetNumber}...`);
                const result = await executeTransaction({ ...d, id: poId });
                
                if (result.success) {
                    await db.runTransaction(async t => {
                         const hRef = db.collection('users').doc(uid).collection('history').doc(historyId);
                         if((await t.get(hRef)).exists) t.update(hRef, { status:'Sukses', api_msg:'Bot Run: '+result.sn, date_updated:new Date().toISOString() });
                         t.delete(poRef);
                    });
                    await bot.sendMessage(chatId, `✅ SUKSES: ${result.sn}`);
                    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
                } else {
                    await poRef.update({ debugStatus: 'GAGAL', debugLogs: result.sn });
                    await bot.sendMessage(chatId, `❌ GAGAL: ${result.sn}`);
                }
            } 
            else if (action === 'MANUAL_ACC') {
                await db.runTransaction(async t => {
                    const hRef = db.collection('users').doc(uid).collection('history').doc(historyId);
                    t.update(hRef, { status:'Sukses', api_msg:'Manual Bot', date_updated:new Date().toISOString() });
                    t.delete(poRef);
                });
                await bot.sendMessage(chatId, `✅ Manual SUKSES.`);
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            } 
            else if (action === 'MANUAL_REJ') {
                await db.runTransaction(async t => {
                    const uRef = db.collection('users').doc(uid);
                    const hRef = uRef.collection('history').doc(historyId);
                    const u = await t.get(uRef);
                    t.update(uRef, { balance: (u.data().balance||0) + (d.price||0) });
                    t.update(hRef, { status:'Gagal', api_msg:'Refund Bot', balance_final:(u.data().balance||0)+(d.price||0), is_refunded:true, date_updated:new Date().toISOString() });
                    t.delete(poRef);
                });
                await bot.sendMessage(chatId, `❌ Refund BERHASIL.`);
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            }
            await bot.answerCallbackQuery(query.id);
        } catch (e) { await bot.sendMessage(chatId, "Err: " + e.message); }
        return res.status(200).send('OK');
    }

    // 3. HANDLE PESAN TEXT
    if (body.message && body.message.text) {
        const chatId = body.message.chat.id;
        const text = body.message.text;
        
        const sessionRef = db.collection('bot_sessions').doc(String(chatId));
        const sessionSnap = await sessionRef.get();
        const isLoggedIn = sessionSnap.exists && sessionSnap.data().isLoggedIn;

        if (text === '🚪 Logout' || text === '/logout') {
            await sessionRef.delete();
            await bot.sendMessage(chatId, "👋 Logout berhasil.", { reply_markup: { remove_keyboard: true } });
            setTimeout(() => {
                bot.sendMessage(chatId, "Silakan login kembali.", {
                    reply_markup: { keyboard: [[{ text: "🔐 LOGIN DASHBOARD", web_app: { url: WEB_APP_URL } }]], resize_keyboard: true }
                });
            }, 500);
            return res.status(200).send('OK');
        }

        if (text === '/start') {
            if (isLoggedIn) {
                await bot.sendMessage(chatId, "✅ <b>Bot Siap!</b>", { parse_mode: 'HTML', reply_markup: mainMenu });
            } else {
                await bot.sendMessage(chatId, "👋 Halo Admin!\nSilakan klik tombol di bawah untuk login.", {
                    reply_markup: { keyboard: [[{ text: "🔐 LOGIN DASHBOARD", web_app: { url: WEB_APP_URL } }]], resize_keyboard: true }
                });
            }
        }
        
        else if (isLoggedIn) {
            if (text === '🚀 RUN AUTO MASSAL') {
                await bot.sendMessage(chatId, "🔄 Mass Run (Limit 5)...");
                const q = await db.collection('preorders').orderBy('timestamp','desc').limit(5).get();
                if(q.empty) return bot.sendMessage(chatId, "✅ Antrian bersih.");
                
                let report = "📝 <b>Massal Run:</b>\n";
                for(const d of q.docs) {
                    const dat = d.data();
                    if(dat.debugStatus==='TERBELI') continue;
                    const res = await executeTransaction({...dat, id:d.id});
                    if(res.success) {
                        await db.runTransaction(async t=>{ 
                            const hRef = db.collection('users').doc(dat.uid).collection('history').doc(dat.historyId||"PO-"+d.id);
                            if((await t.get(hRef)).exists) t.update(hRef,{status:'Sukses',api_msg:'Massal: '+res.sn,date_updated:new Date().toISOString()});
                            t.delete(d.ref);
                        });
                        report += `✅ ${dat.targetNumber}: OK\n`;
                    } else {
                        await d.ref.update({debugStatus:'GAGAL', debugLogs: res.sn});
                        report += `❌ ${dat.targetNumber}: ${res.sn}\n`;
                    }
                }
                await bot.sendMessage(chatId, report, {parse_mode:'HTML'});
            }
            // --- UPDATE BAGIAN INI ---
            else if (text === '📋 Cek Antrian Preorder') {
                const q = await db.collection('preorders').orderBy('timestamp','desc').limit(5).get();
                if(q.empty) return bot.sendMessage(chatId, "✅ Antrian bersih.");
                
                for(const d of q.docs) {
                    const dat = d.data();
                    const st = dat.debugStatus === 'GAGAL' ? '🔴 GAGAL' : '🟡 PENDING';
                    
                    // --- FORMAT PESAN BARU ---
                    const msg = `<b>${st}</b>\n` +
                                `User: <code>${dat.username || 'Unknown'}</code>\n` +
                                `Server: <b>${dat.serverType || 'KHFY'}</b>\n` +
                                `Target: <code>${dat.targetNumber}</code>\n` +
                                `Prod: ${dat.provider}\n` +
                                `Logs: <i>${dat.debugLogs || '-'}</i>`;

                    const btn = [
                        [{text:"🚀 RUN",callback_data:`RUN_SINGLE__${d.id}`}],
                        [{text:"✅ ACC",callback_data:`MANUAL_ACC__${d.id}`},{text:"❌ REJ",callback_data:`MANUAL_REJ__${d.id}`}]
                    ];
                    await bot.sendMessage(chatId, msg, {parse_mode:'HTML', reply_markup:{inline_keyboard:btn}});
                }
            }
        } else {
            await bot.sendMessage(chatId, "🔒 Akses ditolak.", {
                reply_markup: { keyboard: [[{ text: "🔐 LOGIN DASHBOARD", web_app: { url: WEB_APP_URL } }]], resize_keyboard: true }
            });
        }
    }

    return res.status(200).send('OK');
}