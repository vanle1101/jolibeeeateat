
import fs from 'fs';

async function generateImage(prompt, filename) {
    console.log('Ðang t?o ?nh v?i Prompt:', prompt);
    console.log('Vui lòng d?i vài giây...');
    
    try {
        // Pollinations URL: encode the prompt text safely
        const encodedPrompt = encodeURIComponent(prompt);
        // Thêm tham s? model=flux (ho?c xóa di d? dùng m?c d?nh), nologo=true d? b? watermark
        const url = \https://image.pollinations.ai/prompt/\?width=1024&height=1024&nologo=true\;
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error('L?i khi g?i API: ' + response.statusText);
        }
        
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(filename, Buffer.from(buffer));
        
        console.log('? Ðã t?o ?nh thành công và luu t?i:', filename);
    } catch (error) {
        console.error('? L?i t?o ?nh:', error.message);
    }
}

// Ch?y th? v?i m?t câu l?nh
const prompt = 'a cute cybernetic cat hacking on a laptop, futuristic neon city background, 8k resolution, highly detailed';
const outputFile = 'my-generated-image.jpg';

generateImage(prompt, outputFile);

