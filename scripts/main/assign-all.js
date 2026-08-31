
import http from 'http';

http.get('http://127.0.0.1:3010/accounts', (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
        const accounts = JSON.parse(body);
        const toImport = accounts.map(acc => ({ email: acc.email, status: acc.status }));
        
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
                console.log('Successfully assigned proxies to all accounts!');
            });
        });
        
        req.write(JSON.stringify({ accounts: toImport, autoAssignStoredProxies: true }));
        req.end();
    });
});

