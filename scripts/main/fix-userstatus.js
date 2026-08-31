
const fs = require('fs');
const path = 'src/index.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
    'this.userData.initialPoints = data.dashboard.userStatus.availablePoints',
    'this.userData.initialPoints = data?.dashboard?.userStatus?.availablePoints ?? 0'
);
code = code.replace(
    'this.userData.currentPoints = data.dashboard.userStatus.availablePoints',
    'this.userData.currentPoints = data?.dashboard?.userStatus?.availablePoints ?? 0'
);

fs.writeFileSync(path, code);

