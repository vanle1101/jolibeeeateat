
import http from 'http';

http.get('http://127.0.0.1:3010/accounts', (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
        const response = JSON.parse(body);
        const toImport = response.accounts.map(acc => ({ email: acc.email, status: acc.status }));
        
        const req = http.request({
            hostname: '127.0.0.1',
            port: 3010,
            path: '/accounts/import',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res2) => {
            let body2 = '';
            res2.on('data', d => body2 += d);
            res2.on('end', () => {
                if (res2.statusCode === 200) {
                    console.log('Successfully assigned proxies to all accounts!');
                } else {
                    console.log('Failed:', res2.statusCode, body2);
                }
            });
        });
        
        req.write(JSON.stringify({ accounts: toImport, autoAssignStoredProxies: true }));
        req.end();
    });
});

