
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const jsonPath = path.join(__dirname, 'proxies_to_import.json');
const bundle = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const req = http.request({
    hostname: '127.0.0.1',
    port: 3010,
    path: '/accounts/import',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    }
}, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
        if (res.statusCode === 200) {
            console.log('Successfully imported proxies!');
        } else {
            console.log('Failed to import:', res.statusCode, body);
        }
    });
});

req.on('error', (e) => {
    console.error('Error connecting to API. Is the Dashboard/API running?', e);
});

req.write(JSON.stringify(bundle));
req.end();

