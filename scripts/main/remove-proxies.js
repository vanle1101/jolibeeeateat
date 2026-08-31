
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/accounts.db');
db.prepare('UPDATE accounts SET proxy_id = NULL, use_proxy = 0').run();
console.log('Successfully removed proxies from all accounts. The bot will now use the direct VPS connection.');

