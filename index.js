import Slimbot from 'slimbot';
import { bech32, bech32m } from 'bech32';
import redis from "redis";

import 'websocket-polyfill'
import { SimplePool } from "nostr-tools";

const redisClient = redis.createClient();
await redisClient.connect();
import LNBits from 'lnbits';
const lnbits = LNBits.default;

const token = '...';
const slimbot = new Slimbot(token);

const pool = new SimplePool()
const relays = [
    'wss://atlas.nostr.land',
    'wss://eden.nostr.land',
    'wss://nos.lol',
    'wss://nostr-pub.wellorder.net',
    'wss://purplepag.es',
    'wss://nostr-relay.aapi.me',
    'wss://nostr-relay.nokotaro.com',
    'wss://nostr.21crypto.ch',
    'wss://nostr.jatm.link',
    'wss://nostr1.tunnelsats.com',
    'wss://puravida.nostr.land/',
    'wss://relay.current.fyi',
    'wss://relay.damus.io/',
    'wss://relay.f7z.io',
    'wss://relay.nostr.band',
    'wss://relay.nostr.info',
]

function npubToPubkey(npub) {
    let {words} = bech32.decode(npub);
    return Buffer.from(bech32.fromWords(words).slice(0, 32)).toString('hex')
}

async function getProfile(pubkey) {
    const a = await pool.list(relays, [
        {kinds:[0], authors: [pubkey]}
    ])

    let profile = a.sort((a,b) => b.created_at - a.created_at)[0]
    try {
        profile = profile ? JSON.parse(profile.content) : {};
    } catch (e) { console.error(e, profile) }

    return profile;
}

async function onEvent(event) {
    const destPub = event.tags.find(t=>t[0] == 'p')[1]

    // get chatId from redis headsup:subscriptions
    const hex = destPub;
    const chatId = await redisClient.hGet('headsup:subscriptions', hex);

    if (!chatId) {
        console.log(`❌ no chatId for ${hex}`)
    } else {
        const lock = await redisClient.get(`headsup:lock:${hex}`);

        if (lock) {
            console.log(`🤐 lock exists for ${hex}`);
            return;
        }

        let profile, name;
        let recipientProfile, recipientName;

        try { profile = await getProfile(event.pubkey) } catch (e){ console.error(e)};
        try { recipientProfile = await getProfile(hex) } catch (e){ console.error(e)};

        console.log({profile, hex, recipientProfile});

        if (profile) {
            name = profile.name || profile.display_name || profile.displayName
            if (name && profile.nip05) { name = `${name} (${profile.nip05})` }
        }

        if (!name) name = event.pubkey;

        if (recipientProfile) {
            recipientName = recipientProfile.name || recipientProfile.display_name || recipientProfile.displayName
            if (recipientName && recipientProfile.nip05) { recipientName = `${recipientName} (${recipientProfile.nip05})` }
        }

        if (recipientName) {
            recipientName = ` (for ${recipientName})`;
        } else {
            recipientName = '';
        }

        console.log(`✅ You received a new DM from ${name}${recipientName}`);
        slimbot.sendMessage(chatId, `You received a new DM from ${name}${recipientName}`);

        redisClient.set(`headsup:lock:${hex}`, '1', {'EX': 60});
    }
}

setTimeout(async () => {
    const subscriptions = await redisClient.hGetAll('headsup:subscriptions');
    let pubkeys = new Set();
    Object.keys(subscriptions).forEach((hex) => {
        if (!pubkeys.has(hex)) {
            pubkeys.add(hex);
        }
    })

    let chunk = 25;
    let i,j,temparray;
    for (i = 0 ,j=pubkeys.size; i<j; i+=chunk) {
        temparray = Array.from(pubkeys).slice(i,i+chunk);
        await monitorPubkey(temparray);
    }
}, 100);

async function monitorPubkey(pubkeys) {
    console.log(`👀 monitor ${pubkeys.join(', ')}`);
    let now = new Date().getTime();
    let sub = pool.sub(relays, [
        { kinds: [4], '#p': pubkeys, since: parseInt(now / 1000) - 60 } // all DMs in the past 50 seconds ago
    ])
    sub.on('event', onEvent);

    setTimeout(() => {
        sub.unsub();
        setTimeout(() => { monitorPubkey(pubkeys) }, 250);
    }, 60000); // resubscribe every 60 seconds
}

let askedForSats = {};;

slimbot.on('message', async (message) => {
    const chatId = message.chat.id;
    const {text} = message;

    if (!text) {
        return;
    }

    if (askedForSats[chatId] && text.match(/^\d+/)) {
        const sat = parseInt(text);
        const invoice = await createInvoice(sat);
        slimbot.sendMessage(chatId, `lightning:${invoice.payment_request}`);
        slimbot.sendPhoto(message.chat.id, `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=lightning:${invoice.payment_request}`).then(message => {
            console.log(message.result.photo);
        });
        slimbot.sendMessage(chatId, `🙌⚡️`);
    } else if (!text.startsWith('npub')) {
        slimbot.sendMessage(chatId, 'PV! send me an npub to start monitoring notifications for it')
    } else {
        let hex;

        try {
            hex = npubToPubkey(text);
        } catch (e) {
            slimbot.sendMessage(chatId, `can't decode ${text.slice(0, 99)}`);
            console.log(e, {text});
            return;
        }

        monitorPubkey([hex]);
        // stored in redis in a hash called headsup:subscriptions where npub is the key and chatId is the value
        await redisClient.hSet('headsup:subscriptions', hex, chatId);
        slimbot.sendMessage(chatId, `🤙`);
        setTimeout(() => {
            slimbot.sendMessage(chatId, `Adding this pubkey for monitoring of DMs -- I'll ping you on this chat when you have something new`)
        }, 800);
        setTimeout(() => {
            slimbot.sendMessage(chatId, `Want to do some V4V? Write a sat amount and I'll get a LN invoice ⚡️`)
            askedForSats[chatId] = true;
        }, 1600);
    }
});

slimbot.startPolling();

function getWallet () {
    return lnbits({
        adminKey: "",
        invoiceReadKey: '...',
        endpoint: '...',
    });
}

async function createInvoice(amount) {
    const { wallet, userManager, paywall, withdraw, paylink, tpos } = getWallet();

    const newInvoice = await wallet.createInvoice({
        amount: amount,
        memo: 'Nostr DMs bot V4V',
        out: false,
    });

    return newInvoice;
}
