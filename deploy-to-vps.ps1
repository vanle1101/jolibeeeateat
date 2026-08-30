# ==========================================================
# SCRIPT TỰ ĐỘNG SYNC & DEPLOY TỪ MÁY THẬT LÊN VPS / RDP
# ==========================================================

param (
    [string]$VpsIp = "192.168.1.100",   # Thay bằng IP của VPS / RDP
    [string]$VpsUser = "root",          # Username VPS (Linux: root, Windows: Administrator)
    [string]$RemotePath = "/opt/reward" # Thư mục đích trên VPS
)

Write-Host ">>> [1/3] Đang đồng bộ code & cấu hình lên VPS ($VpsIp)..." -ForegroundColor Cyan

# Danh sách các file/thư mục loại trừ không cần upload
$excludes = @("node_modules", "dist", ".git", ".system_generated")

# Sử dụng scp hoặc rsync để đẩy file
$sourcePath = "$PSScriptRoot\*"
scp -r $PSScriptRoot "$($VpsUser)@$($VpsIp):$($RemotePath)"

Write-Host ">>> [2/3] Đang gửi lệnh build & restart trên VPS..." -ForegroundColor Cyan
ssh "$($VpsUser)@$($VpsIp)" "cd $RemotePath && npm run build && pm2 restart rewards-bot 2>/dev/null || npm start"

Write-Host ">>> [3/3] Deploy hoàn tất thành công!" -ForegroundColor Green
