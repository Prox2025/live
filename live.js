const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');

(async () => {
  const inputUrl = process.argv[2];
  const streamUrl = process.env.STREAM_URL;

  if (!inputUrl || !streamUrl) {
    console.error('❌ Erro: forneça a URL do vídeo e a variável STREAM_URL.');
    process.exit(1);
  }

  console.log(`🌍 URL do vídeo recebido: ${inputUrl}`);
  console.log(`📡 URL de transmissão (stream_url): ${streamUrl}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  try {
    console.log('🔎 Acessando o Google Drive...');
    await page.goto(inputUrl, { waitUntil: 'networkidle2' });

    const downloadSelector = 'a#uc-download-link';
    console.log('⏳ Aguardando botão "Baixar mesmo assim"...');
    await page.waitForSelector(downloadSelector, { timeout: 15000 });

    const downloadUrl = await page.$eval(downloadSelector, el => el.href);
    console.log(`🔗 Link direto obtido: ${downloadUrl}`);

    console.log('⬇️ Baixando vídeo com wget...');
    execSync(`wget -O video_final.mp4 "${downloadUrl}"`, { stdio: 'inherit' });

    if (!fs.existsSync('video_final.mp4')) {
      throw new Error('❌ O vídeo não foi baixado corretamente.');
    }

    console.log('🎥 Iniciando transmissão com FFmpeg...');
    execSync(
      `ffmpeg -re -i video_final.mp4 ` +
      `-c:v libx264 -preset veryfast -maxrate 3000k -bufsize 6000k ` +
      `-vf "scale=-2:720" -c:a aac -b:a 128k -ar 44100 ` +
      `-f flv "${streamUrl}"`,
      { stdio: 'inherit' }
    );

    console.log('✅ Live finalizada com sucesso.');

  } catch (error) {
    console.error('❌ Erro ao processar:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
