import fs from 'fs';
import https from 'https';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const bundle = JSON.parse(fs.readFileSync('scripts/main/proxies_to_import.json', 'utf8'));
const validProxies = [];
let tested = 0;

async function checkProxy(p) {
    return new Promise((resolve) => {
        let agent;
        try {
            if (p.url.startsWith('http')) {
                agent = new HttpProxyAgent(p.url);
            } else if (p.url.startsWith('socks')) {
                agent = new SocksProxyAgent(p.url);
            } else {
                resolve(false);
                return;
            }
        } catch (e) {
            resolve(false);
            return;
        }

        const req = https.get('https://www.bing.com', {
            agent,
            timeout: 5000,
            rejectUnauthorized: false
        }, (res) => {
            res.resume();
            if (res.statusCode >= 200 && res.statusCode < 400) {
                resolve(true);
            } else {
                resolve(false);
            }
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function run() {
    console.log('Testing ' + bundle.proxies.length + ' proxies...');
    const queue = [...bundle.proxies];
    const concurrency = 100;

    async function worker() {
        while (queue.length > 0) {
            const p = queue.shift();
            const ok = await checkProxy(p);
            tested++;
            if (ok) {
                validProxies.push(p);
                console.log(`[${tested}/${bundle.proxies.length}] VALID: ${p.url}`);
            } else {
                console.log(`[${tested}/${bundle.proxies.length}] DEAD: ${p.url}`);
            }
        }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    bundle.proxies = validProxies;
    fs.writeFileSync('scripts/main/proxies_to_import.json', JSON.stringify(bundle, null, 2));
    console.log('Done! Valid proxies:', validProxies.length);
}

run();
