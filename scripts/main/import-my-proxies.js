
const fs = require('fs');
const path = require('path');
const http = require('http');

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
            console.log(body);
        } else {
            console.log('Failed to import:', res.statusCode, body);
        }
    });
});

req.on('error', (e) => {
    console.error('Error connecting to API:', e);
});

req.write(JSON.stringify(bundle));
req.end();

