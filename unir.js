const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const keyFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
const input = JSON.parse(fs.readFileSync('input.json', 'utf-8'));

let videoPath = input.video_principal;
const streamUrl = input.stream_url || '';
const id = input.id || 'sem_id';

const videoOut = 'video_final_completo.mp4';
const infoOut = 'stream_info.json';
const remotePadrao = 'meudrive'; // ✅ Altere se necessário

if (!videoPath) {
  console.error('❌ Caminho do vídeo principal ausente em input.json!');
  process.exit(1);
}

// ✅ Corrigir automaticamente se não for caminho remoto
if (!videoPath.includes(':')) {
  console.warn(`⚠️ Caminho de vídeo sem remoto detectado. Ajustando para: ${remotePadrao}:${videoPath}`);
  videoPath = `${remotePadrao}:${videoPath}`;
}

console.log(`📥 Baixando vídeo principal: ${videoPath}`);

try {
  if (!fs.existsSync(keyFile)) {
    throw new Error('Arquivo rclone.conf não encontrado em: ' + keyFile);
  }

  execSync(`rclone copyto "${videoPath}" "${videoOut}" --config "${keyFile}" --progress`, {
    stdio: 'inherit',
  });

  console.log(`✅ Vídeo baixado como: ${videoOut}`);
} catch (err) {
  console.error('❌ Erro ao baixar vídeo com rclone:', err.message);
  process.exit(1);
}

// 🔽 Salvar info da transmissão
fs.writeFileSync(infoOut, JSON.stringify({ id, stream_url: streamUrl }, null, 2));
console.log(`✅ Arquivo de info salvo: ${infoOut}`);
