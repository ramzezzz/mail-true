/**
 * Правила разбора кода.
 *
 * Скрипт `npm run lint` в хранилище был с самого начала, а самого ESLint не
 * было ни в одном пакете: команда падала, и её просто перестали запускать.
 * То есть проверка существовала на бумаге — ровно та же болезнь, что кнопка
 * без поведения, только со стороны разработки.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ НЕ «ВСЁ РЕКОМЕНДОВАННОЕ»
 * ------------------------------------------------------------------
 * Полный набор `recommendedTypeChecked` дал на нашем коде 779 замечаний,
 * из которых 630 — три правила вкуса:
 *
 *   require-await (436)  — маршрут Fastify обязан быть async, даже если
 *                          внутри нет await; это требование чужой рамки,
 *                          а не ошибка;
 *   unbound-method (114) — почти всё из проверок, где метод намеренно
 *                          передаётся ссылкой в подделку;
 *   no-unnecessary-type-assertion (80) — спор о стиле сужения типов.
 *
 * Линтер, который кричит семьсот раз, не читают вовсе — и вместе с шумом
 * теряются восемь настоящих незаконченных обещаний. Поэтому набор собран
 * поимённо: **правило должно ловить ошибку, а не вкус**. Отступы, кавычки и
 * порядок импортов оставлены Prettier — спорить двумя инструментами сразу
 * бессмысленно.
 *
 * Что оставлено и почему именно это:
 *
 *   no-floating-promises   — на незаконченном обещании у нас молча терялись
 *                            выход из ящика и отправка письма;
 *   no-misused-promises    — async-обработчик там, где ждут обычную функцию;
 *   await-thenable         — await перед тем, что обещанием не является;
 *   no-base-to-string      — «[object Object]» в тексте для человека;
 *   no-irregular-whitespace — у нас уже была история с управляющими
 *                            байтами в исходниках (см. source-hygiene.test.ts);
 *   правила хуков React    — их нарушение видно только в браузере и только
 *                            иногда.
 */

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    // Собранное, чужое и созданное на ходу разбирать нечего.
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.playwright-mcp/**',
      '**/*.d.ts',
      '**/coverage/**',
      'docs/manual/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    ...tseslint.configs.recommendedTypeChecked[2],
    languageOptions: {
      parserOptions: {
        /*
         * Свой проект для разбора (tsconfig.eslint.json), а не projectService.
         *
         * Рабочие tsconfig собирают приложения и включают только `src/**`:
         * проверки, конфигурации сборки и сценарии в них не входят —
         * компилировать их незачем. Линтеру же нужны все, иначе он отвечает
         * «файл не найден проектом»: так было с 88 файлами, причём при
         * полном прогоне терялись и те, что по одному разбирались отлично.
         */
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // --- то, ради чего всё и заведено ---
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/only-throw-error': 'error',

      // --- шум, объяснённый в шапке ---
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',

      /*
       * Границы с чужими службами (IMAP, SMTP, ответы серверов) по своей
       * природе приходят как any; разбираются они схемами zod там, где это
       * действительно нужно, — это надёжнее общего запрета.
       */
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',

      // Остаток разбираемого кода — повод посмотреть, но не остановить сборку.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Правила хуков — только там, где есть React.
    files: ['apps/web/**/*.{ts,tsx}', 'apps/admin/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    /*
     * Проверки живут по своим правилам: там нарочно бывают и пустые
     * заглушки, и обращения к внутренностям — это их работа. Незаконченное
     * обещание в проверке видно сразу по красному результату.
     */
    files: ['**/*.test.{ts,tsx,mjs}', '**/tests/**', '**/scripts/**', '**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Подделки чужих клиентов часто держат ссылку на себя, чтобы вложенный
      // объект мог записать вызов: в проверке это нормальный приём.
      '@typescript-eslint/no-this-alias': 'off',
      /*
       * «[object Object]» в рабочем коде доезжает до человека молча — там
       * правило и нужно. В проверке оно приводит к падению разбора JSON,
       * то есть к красному результату, который никто не пропустит. Случаи,
       * где проверка могла бы, наоборот, зеленеть впустую, исправлены по
       * существу (см. migrate-routes.test.ts, migrate-runner.test.ts).
       */
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    /*
     * Живые проверки стенда написаны в стиле «условие ? успех : отказ» —
     * это их способ печатать итог, а не забытый вызов. Правило тут ловит
     * стиль, а не ошибку.
     */
    files: ['infra/**/*.mjs'],
    rules: { '@typescript-eslint/no-unused-expressions': 'off' },
  },
  {
    /*
     * Файлы настроек, сценарии сборки и Service Worker типами не покрыты.
     * Им нужны свои имена окружения, иначе `document` и `setTimeout`
     * выглядят необъявленными — 114 ложных замечаний.
     */
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.serviceworker },
    },
  },
);
