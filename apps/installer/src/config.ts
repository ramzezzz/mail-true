/**
 * Настройки веб-установщика.
 *
 * Их намеренно мало. Установщик — это не ещё одна служба продукта со своим
 * набором ключей: всё, что он умеет настраивать, он спрашивает у человека
 * в браузере и пишет в infra/.env. Здесь только то, без чего он не найдёт
 * ни каталог проекта, ни собственный контейнер.
 */

export interface InstallerConfig {
  /** Адрес и порт ВНУТРИ контейнера. Наружу выводит ports в compose. */
  readonly HOST: string;
  readonly PORT: number;
  /** Порт на хосте — только чтобы назвать человеку правильный адрес. */
  readonly INSTALLER_PORT: string;
  readonly LOG_LEVEL: string;
  /**
   * Имя проекта Docker Compose. Нужно дважды: найти свой контейнер среди
   * чужих и запускать docker compose в том же проекте, а не в новом.
   */
  readonly COMPOSE_PROJECT_NAME: string;
  /**
   * Отметка «установлено» на момент запуска контейнера. Установщик всё
   * равно перечитывает infra/.env и базу, но этот снимок позволяет ему
   * отказаться сразу — до того, как он что-либо откроет.
   */
  readonly INSTALL_COMPLETED_AT: string;
  /** Точка монтирования каталога проекта внутри контейнера. */
  readonly MT_REPO_MOUNT: string;
}

function envStr(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function loadConfig(): InstallerConfig {
  const port = Number.parseInt(envStr('PORT', '8099'), 10);
  return {
    HOST: envStr('HOST', '0.0.0.0'),
    PORT: Number.isFinite(port) ? port : 8099,
    INSTALLER_PORT: envStr('INSTALLER_PORT', '8099'),
    LOG_LEVEL: envStr('LOG_LEVEL', 'info'),
    COMPOSE_PROJECT_NAME: envStr('COMPOSE_PROJECT_NAME', 'mailtrue'),
    INSTALL_COMPLETED_AT: envStr('INSTALL_COMPLETED_AT', ''),
    MT_REPO_MOUNT: envStr('MT_REPO_MOUNT', '/repo'),
  };
}
