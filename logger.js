'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');

function pad(value) {
  return value < 10 ? '0' + value : String(value);
}

function dateStamp(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + '_' +
    pad(date.getHours()) + '-' + pad(date.getMinutes()) + '-' + pad(date.getSeconds());
}

function timeStamp(date) {
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function createLogger() {
  const startedAt = new Date();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    console.error('Не удалось создать папку logs:', err.message);
  }

  const file = path.join(LOG_DIR, dateStamp(startedAt) + '.txt');
  try {
    fs.writeFileSync(file, '', 'utf8');
  } catch (err) {
    console.error('Не удалось создать файл лога:', err.message);
  }

  let active = true;

  function write(level, text) {
    const line = '[' + timeStamp(new Date()) + '] ' + level + ' ' + text;
    if (active) {
      try {
        fs.appendFileSync(file, line + '\n', 'utf8');
      } catch (err) {
        /* не роняем игру из-за лога */
      }
    }
    if (level === 'ERROR') console.error(line);
    else console.log(line);
  }

  return {
    file: file,
    info: function (text) { write('INFO ', text); },
    event: function (text) { write('EVENT', text); },
    warn: function (text) { write('WARN ', text); },
    error: function (text) { write('ERROR', text); },
    close: function () { active = false; }
  };
}

module.exports = { createLogger: createLogger, LOG_DIR: LOG_DIR };
