
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function processarVideo() {
  const comando = [
    '-i', 'parte1_720.mp4',
    '-i', 'logo.png',
    '-i', 'rodape.webm',
    '-filter_complex',
    `[0:v]format=rgba,split=2[base1][base2];` +
    `[1:v]format=rgba,scale=iw*0.1:-1,setpts=PTS-STARTPTS[logov];` +
    `[2:v]format=rgba,setpts=PTS-STARTPTS+180/TB[rodsrc];` +
    `[rodsrc][base1]scale2ref=iw:-1[rodv][ref];[ref]nullsink;` +
    `[base2][logov]overlay=W-w-20:20[tmpv];` +
    `[tmpv][rodv]overlay=(W-w)/2:H-h-20:enable='between(t,180,206)'[outv]`,
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-y', 'parte1_final.mp4'
  ];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', comando, { stdio: 'inherit', shell: true });

    ffmpeg.on('exit', (code) => {
      if (code === 0) {
        const stats = fs.statSync('parte1_final.mp4');
        const tamanhoMB = (stats.size / (1024 * 1024)).toFixed(2);
        const ffprobe = spawn('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          'parte1_final.mp4'
        ]);

        let duracao = '';
        ffprobe.stdout.on('data', data => duracao += data.toString());
        ffprobe.on('exit', () => {
          console.log(`ðŸŽ¬ VÃ­deo final criado: parte1_final.mp4`);
          console.log(`â±ï¸ DuraÃ§Ã£o final: ${parseFloat(duracao).toFixed(2)}s`);
          console.log(`ðŸ“¦ Tamanho final: ${tamanhoMB} MB`);
          resolve();
        });
      } else {
        reject(new Error(`FFmpeg falhou (cÃ³digo ${code})`));
      }
    });
  });
}

processarVideo().catch(err => {
  console.error('ðŸš¨ Erro:', err.message);
});
