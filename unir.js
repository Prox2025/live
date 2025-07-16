const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// Caminho do arquivo de configuração do rclone
const keyFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');

// Carrega input.json
const input = JSON.parse(fs.readFileSync('input.json', 'utf-8'));

// Dados do input
const videoPath = input.video_principal;
const streamUrl = input.stream_url || '';
const id = input.id || 'sem_id';

// Arquivos de saída
const videoOut = 'video_final_completo.mp4';
const infoOut = 'stream_info.json';

if (!videoPath) {
  console.error('❌ Caminho do vídeo principal ausente em input.json!');
  process.exit(1);
}

console.log(`📥 Baixando vídeo principal: ${videoPath}`);

try {
  // Verifica se o rclone.conf existe
  if (!fs.existsSync(keyFile)) {
    throw new Error('Arquivo rclone.conf não encontrado em: ' + keyFile);
  }

  // Baixa o vídeo usando rclone copyto
  execSync(`rclone copyto "${videoPath}" "${videoOut}" --config "${keyFile}" --progress`, {
    stdio: 'inherit',
  });

  console.log(`✅ Vídeo baixado como: ${videoOut}`);
} catch (err) {
  console.error('❌ Erro ao baixar vídeo com rclone:', err.message);
  process.exit(1);
}

// Salvar informações da transmissão
fs.writeFileSync(infoOut, JSON.stringify({ id, stream_url: streamUrl }, null, 2));
console.log(`✅ Arquivo de info salvo: ${infoOut}`);
