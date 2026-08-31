import fs from 'fs';

async function generateImage(prompt, filename = 'generated-image.jpg') {
    console.log('Đang tạo ảnh với Prompt:', prompt);
    console.log('Vui lòng đợi vài giây...');
    
    try {
        const encodedPrompt = encodeURIComponent(prompt);
        const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 1000000)}`;
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error('Lỗi khi gọi API: ' + response.statusText);
        }
        
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(filename, Buffer.from(buffer));
        
        console.log('✅ Đã tạo ảnh thành công và lưu tại:', filename);
        return filename;
    } catch (error) {
        console.error('❌ Lỗi tạo ảnh:', error.message);
        throw error;
    }
}

const promptArg = process.argv.slice(2).join(' ') || 'a cute cybernetic cat hacking on a laptop, futuristic neon city background, 8k resolution, highly detailed';
const outputFile = 'my-generated-image.jpg';

generateImage(promptArg, outputFile);