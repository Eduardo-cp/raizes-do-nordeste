import { EventEmitter } from 'node:events';

export const eventos = new EventEmitter();
eventos.setMaxListeners(1000);

export function publicar(tipo, dados) {
  eventos.emit('evento', { tipo, dados, em: new Date().toISOString() });
}
