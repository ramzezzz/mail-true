/*
 * Мастер первого запуска Mail.True — сторона браузера.
 *
 * Без сборщика и без библиотек: страница живёт внутри образа, который
 * поднимают один раз в жизни сервера. Всё состояние — один объект, вся
 * отрисовка — одна функция; так проще убедиться, что кнопка не появляется
 * раньше поведения, которое за ней стоит.
 *
 * Ключ доступа хранится в sessionStorage: он живёт до закрытия вкладки и
 * не переживает перезапуск установщика (тот выдаёт новый). В localStorage
 * его класть нельзя — это память надолго, а ключ по смыслу одноразовый.
 */
(function () {
  'use strict';

  var KEY_STORAGE = 'mailtrue.installer.key';

  var state = {
    screen: 'boot',
    key: window.sessionStorage.getItem(KEY_STORAGE) || '',
    keyError: '',
    blocked: null,
    steps: [],
    defaults: {},
    answers: {},
    stepIndex: 0,
    errors: {},
    checks: null,
    checksRunning: false,
    /** Что проверяется прямо сейчас и что уже отработало. */
    checksNow: [],
    checksDone: [],
    traces: [],
    looksConfigured: false,
    confirmOverwrite: false,
    logLines: [],
    logFrom: 0,
    phase: 'idle',
    failure: '',
    summary: null,
    busy: false,
    globalError: '',
    tlsCheck: null,
    tlsProbeFor: '',
    certCheck: null,
    certChecking: false,
  };

  var root = document.getElementById('root');

  // ---------------------------------------------------------------
  // Обращения к установщику
  // ---------------------------------------------------------------

  function api(path, options) {
    var opts = options || {};
    var headers = { 'Content-Type': 'application/json' };
    if (state.key) headers['X-Install-Key'] = state.key;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          return { status: response.status, data: data };
        });
    });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    var name;
    for (name in attrs || {}) {
      if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
      if (name === 'class') node.className = attrs[name];
      else if (name === 'text') node.textContent = attrs[name];
      else if (name === 'html') node.innerHTML = attrs[name];
      else if (name.indexOf('on') === 0) node.addEventListener(name.slice(2), attrs[name]);
      else if (attrs[name] !== null && attrs[name] !== undefined)
        node.setAttribute(name, attrs[name]);
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  // ---------------------------------------------------------------
  // Экраны
  // ---------------------------------------------------------------

  function screenBoot() {
    return el('div', { class: 'card card--narrow' }, [
      el('p', { class: 'muted', text: 'Загружается…' }),
    ]);
  }

  function screenBlocked() {
    var info = state.blocked || {};
    if (info.mode === 'broken') {
      return el('div', { class: 'card card--narrow' }, [
        el('h1', { text: 'Установщик не может работать' }),
        el('div', { class: 'note note--fail', text: info.message || '' }),
        el('p', {
          class: 'muted',
          text:
            'Пока это не исправлено, устанавливать нечем: собрать образы и поднять службы ' +
            'установщик может только через Docker.',
        }),
      ]);
    }

    var where = [];
    if (info.whereEnv) where.push('infra/.env');
    if (info.whereDb) where.push('таблица install_state в базе');

    return el('div', { class: 'card card--narrow' }, [
      el('h1', { text: 'Этот сервер уже установлен' }),
      el('p', {
        class: 'intro',
        text:
          'Мастер первого запуска на нём больше не работает — и это защита, а не поломка. ' +
          'Пройденный второй раз, он заново сгенерировал бы пароль Postgres, а том базы ' +
          'принимает пароль только при создании: доступ к базе разом потеряли бы почта, ' +
          'приём писем и панель управления — при полностью исправной базе.',
      }),
      el('table', { class: 'kv' }, [
        row('Установлен', info.installedAt || 'дата неизвестна'),
        row(
          'Чем ставили',
          info.installedBy === 'installer' ? 'этим мастером' : 'install/install.sh',
        ),
        info.domain ? row('Почтовый домен', info.domain) : null,
        info.hostname ? row('Имя сервера', info.hostname) : null,
        row('Где отметка', where.join(', ') || 'неизвестно'),
      ]),
      el('h2', { text: 'Если вы действительно ставите сервер заново' }),
      el('p', {
        class: 'muted',
        text: 'Отметка снимается одной командой на самом сервере — там, куда веб-доступа нет:',
      }),
      el('div', { class: 'dns', text: 'sudo bash install/allow-reinstall.sh' }),
      el('p', {
        class: 'muted',
        text:
          'Команда спросит подтверждение и не тронет ни писем, ни базы — она только разрешит ' +
          'мастеру запуститься ещё раз. Перед этим стоит снять копию: sudo bash install/backup.sh',
      }),
    ]);
  }

  function row(name, value) {
    return el('tr', {}, [el('td', { text: name }), el('td', { text: value })]);
  }

  function screenKey() {
    var input = el('input', {
      type: 'text',
      id: 'key-input',
      placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX',
      autocomplete: 'off',
      spellcheck: 'false',
      value: state.key,
    });
    var submit = function () {
      var value = input.value.trim();
      if (!value) return;
      state.busy = true;
      render();
      api('/api/session', { method: 'POST', body: { key: value } }).then(function (res) {
        state.busy = false;
        if (res.status === 200) {
          state.key = value;
          window.sessionStorage.setItem(KEY_STORAGE, value);
          state.keyError = '';
          loadContext();
        } else {
          state.keyError = res.data.message || 'Ключ не подошёл.';
          render();
        }
      });
    };
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') submit();
    });

    return el('div', { class: 'card card--narrow' }, [
      el('h1', { text: 'Ключ доступа' }),
      el('p', {
        class: 'intro',
        text:
          'Администратора ещё не существует — спрашивать пароль не у кого. Поэтому право начать ' +
          'установку подтверждается ключом, который установщик напечатал в свой журнал при ' +
          'запуске: его видит тот, у кого есть доступ к серверу, и только он.',
      }),
      el('p', { class: 'muted', text: 'Показать ключ:' }),
      el('div', {
        class: 'dns',
        text: 'docker compose -f infra/docker-compose.yml logs installer',
      }),
      el('div', { class: 'field', style: 'margin-top:20px' }, [
        el('label', { class: 'field__label', for: 'key-input', text: 'Ключ' }),
        input,
        state.keyError ? el('div', { class: 'field__error', text: state.keyError }) : null,
      ]),
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn--main',
          text: state.busy ? 'Проверяем…' : 'Войти',
          disabled: state.busy ? 'disabled' : null,
          onclick: submit,
        }),
      ]),
    ]);
  }

  // --- мастер ------------------------------------------------------

  function rail() {
    // На экранах установки все вопросы уже позади, и текущий пункт —
    // «Установка». Раньше подсветка оставалась на последнем отвеченном
    // шаге: справа шла установка, а слева горели «Размеры и квоты».
    var installing = state.screen === 'run' || state.screen === 'done';
    var items = state.steps.map(function (step, index) {
      var passed = installing || index < state.stepIndex;
      var cls = 'rail__item';
      if (passed) cls += ' rail__item--done';
      else if (index === state.stepIndex) cls += ' rail__item--current';
      return el('div', { class: cls }, [
        el('span', { class: 'rail__num', text: passed ? '✓' : String(index + 1) }),
        el('span', { text: step.title }),
      ]);
    });
    var lastCls = 'rail__item';
    if (state.screen === 'done') lastCls += ' rail__item--done';
    else if (installing) lastCls += ' rail__item--current';
    items.push(
      el('div', { class: lastCls }, [
        el('span', {
          class: 'rail__num',
          text: state.screen === 'done' ? '✓' : String(state.steps.length + 1),
        }),
        el('span', { text: 'Установка' }),
      ]),
    );
    return el('aside', { class: 'rail' }, items);
  }

  function fieldVisible(field) {
    if (!field.showWhen) return true;
    return String(state.answers[field.showWhen.field]) === field.showWhen.equals;
  }

  function setAnswer(name, value) {
    state.answers[name] = value;
    if (state.errors[name]) delete state.errors[name];
  }

  function renderField(field) {
    var error = state.errors[field.name];
    var control;

    if (field.type === 'toggle') {
      control = el('label', { class: 'toggle' }, [
        el('input', {
          type: 'checkbox',
          checked: state.answers[field.name] ? 'checked' : null,
          onchange: function (event) {
            setAnswer(field.name, event.target.checked);
            render();
          },
        }),
        el('span', { text: field.label }),
      ]);
      return el('div', { class: 'field' }, [
        control,
        el('p', { class: 'field__help', text: field.help }),
        field.risk ? el('p', { class: 'field__risk', text: field.risk }) : null,
      ]);
    }

    if (field.type === 'select') {
      var options = (field.options || []).map(function (option) {
        var on = state.answers[field.name] === option.value;
        return el('label', { class: 'choice' + (on ? ' choice--on' : '') }, [
          el('div', {}, [
            el('input', {
              type: 'radio',
              name: field.name,
              checked: on ? 'checked' : null,
              onchange: function () {
                setAnswer(field.name, option.value);
                render();
              },
            }),
            el('span', { class: 'choice__title', text: ' ' + option.label }),
          ]),
          el('div', { class: 'choice__note', text: option.note }),
        ]);
      });
      return el('div', { class: 'field' }, [
        el('span', { class: 'field__label', text: field.label }),
        el('div', {}, options),
        field.help ? el('p', { class: 'field__help', text: field.help }) : null,
        error ? el('div', { class: 'field__error', text: error }) : null,
      ]);
    }

    if (field.type === 'pem') {
      // Файл выбирают мышью или вставляют текстом: и то и другое приходит
      // одинаково — сертификат в формате PEM есть просто текст.
      var area = el('textarea', {
        rows: '5',
        spellcheck: 'false',
        class: 'pem' + (error ? ' is-bad' : ''),
        placeholder: '-----BEGIN CERTIFICATE-----',
        oninput: function (event) {
          setAnswer(field.name, event.target.value);
          state.certCheck = null;
        },
      });
      area.value = state.answers[field.name] === undefined ? '' : String(state.answers[field.name]);
      var picker = el('input', {
        type: 'file',
        accept: '.pem,.crt,.cer,.key,.txt',
        onchange: function (event) {
          var file = event.target.files && event.target.files[0];
          if (!file) return;
          file.text().then(function (text) {
            setAnswer(field.name, text);
            state.certCheck = null;
            render();
          });
        },
      });
      return el('div', { class: 'field' }, [
        el('label', { class: 'field__label', text: field.label }),
        field.help ? el('p', { class: 'field__help', text: field.help }) : null,
        field.risk ? el('p', { class: 'field__risk', text: field.risk }) : null,
        picker,
        area,
        error ? el('div', { class: 'field__error', text: error }) : null,
      ]);
    }

    if (field.type === 'bytes') {
      var divisor = field.units === 'GiB' ? 1024 * 1024 * 1024 : 1024 * 1024;
      var current = Number(state.answers[field.name] || 0) / divisor;
      control = el('div', { class: 'bytes' }, [
        el('input', {
          type: 'number',
          min: '1',
          step: '1',
          value: String(Math.round(current * 100) / 100),
          class: error ? 'is-bad' : null,
          oninput: function (event) {
            setAnswer(field.name, Math.round(Number(event.target.value) * divisor));
          },
        }),
        el('span', { class: 'muted', text: field.units === 'GiB' ? 'ГиБ' : 'МиБ' }),
      ]);
    } else {
      var inputType =
        field.type === 'port' ? 'number' : field.type === 'select' ? 'text' : field.type;
      control = el('input', {
        type: inputType,
        value: state.answers[field.name] === undefined ? '' : String(state.answers[field.name]),
        placeholder: field.placeholder || '',
        autocomplete: field.type === 'password' ? 'new-password' : 'off',
        spellcheck: 'false',
        class: error ? 'is-bad' : null,
        oninput: function (event) {
          setAnswer(
            field.name,
            field.type === 'port' ? Number(event.target.value) : event.target.value,
          );
        },
      });
    }

    return el('div', { class: 'field' }, [
      el('label', { class: 'field__label', text: field.label }),
      field.help ? el('p', { class: 'field__help', text: field.help }) : null,
      field.risk ? el('p', { class: 'field__risk', text: field.risk }) : null,
      control,
      error ? el('div', { class: 'field__error', text: error }) : null,
    ]);
  }

  function checkRow(check) {
    var mark = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '×';
    return el('div', { class: 'check check--' + check.status }, [
      el('span', { class: 'check__mark', text: mark }),
      el('div', {}, [
        el('div', { class: 'check__title', text: check.title }),
        el('div', { class: 'check__detail', text: check.detail }),
        check.hint ? el('div', { class: 'check__hint', text: check.hint }) : null,
      ]),
    ]);
  }

  /**
   * Пока идёт проверка, спрашиваем сервер, что он делает прямо сейчас.
   * Проверка портов — девять запусков контейнера, исходящий 25-й ждёт
   * ответа чужих MX: без этого экран полминуты выглядит зависшим.
   */
  function pollChecks() {
    if (!state.checksRunning) return;
    api('/api/checks/progress').then(function (res) {
      if (!state.checksRunning) return;
      if (res.status === 200) {
        state.checksNow = res.data.running || [];
        state.checksDone = res.data.done || [];
        render();
      }
      window.setTimeout(pollChecks, 600);
    });
  }

  function runChecks() {
    state.checksRunning = true;
    state.checksNow = [];
    state.checksDone = [];
    render();
    window.setTimeout(pollChecks, 300);
    api('/api/checks', { method: 'POST', body: state.answers }).then(function (res) {
      state.checksRunning = false;
      state.checksNow = [];
      state.checks = res.status === 200 ? res.data.checks : null;
      if (res.status !== 200) state.globalError = res.data.message || 'Проверка не удалась.';
      render();
    });
  }

  function stepSystem(step) {
    var body = [];
    if (state.checksRunning) {
      var now = state.checksNow || [];
      body.push(
        el('p', { class: 'progress-line' }, [
          el('span', { class: 'spinner' }),
          el('span', {
            text: now.length
              ? 'Проверяем: ' + now.join(', ')
              : 'Смотрим память, диск, версию Docker и занятость портов…',
          }),
        ]),
      );
      (state.checksDone || []).forEach(function (title) {
        body.push(
          el('div', { class: 'check check--ok' }, [
            el('span', { class: 'check__mark', text: '✓' }),
            el('div', {}, [el('div', { class: 'check__title', text: title })]),
          ]),
        );
      });
    } else if (state.checks === null) {
      body.push(el('p', { class: 'muted', text: 'Проверка ещё не запускалась.' }));
    } else {
      state.checks.forEach(function (check) {
        body.push(checkRow(check));
      });
    }

    var failed = (state.checks || []).filter(function (check) {
      return check.status === 'fail';
    });

    return {
      body: body,
      before: failed.length
        ? el('div', { class: 'note note--fail' }, [
            el('div', {
              text:
                'Непройденных проверок: ' +
                failed.length +
                '. Продолжить можно, но почти наверняка стек не поднимется — ' +
                'у docker просто не выйдет открыть занятый порт.',
            }),
          ])
        : null,
      extraAction: el(
        'button',
        {
          class: 'btn--plain',
          disabled: state.checksRunning ? 'disabled' : null,
          onclick: runChecks,
        },
        state.checksRunning
          ? [el('span', { class: 'spinner' }), el('span', { text: 'Проверяем…' })]
          : [el('span', { text: 'Проверить снова' })],
      ),
      nextLabel: 'Далее',
      canNext: !state.checksRunning && state.checks !== null,
      title: step.title,
      intro: step.intro,
    };
  }

  /*
   * Шаг «Сертификат» обещает: «проверку установщик делает сам и скажет,
   * получится ли». Обещание выполняется здесь — до выбора, а не после
   * минуты ожидания и чужого текста про challenge failed.
   */
  function tlsProbe() {
    var host = (state.answers.hostname || '').trim();
    if (!host || state.tlsProbeFor === host) return;
    state.tlsProbeFor = host;
    state.tlsCheck = null;
    render();
    api('/api/tls-check', { method: 'POST', body: { hostname: host } }).then(function (res) {
      state.tlsCheck = res.status === 200 ? res.data.check : null;
      render();
    });
  }

  function checkCustomCert() {
    state.certChecking = true;
    state.certCheck = null;
    render();
    api('/api/tls-custom-check', { method: 'POST', body: state.answers }).then(function (res) {
      state.certChecking = false;
      if (res.status === 200) {
        state.certCheck = res.data.result;
      } else {
        state.globalError = res.data.message || 'Проверить сертификат не удалось.';
      }
      render();
    });
  }

  function stepFields(step) {
    var plain = [];
    var advanced = [];
    if (step.id === 'tls') {
      tlsProbe();
      plain.push(
        state.tlsCheck
          ? checkRow(state.tlsCheck)
          : el('p', { class: 'muted' }, [
              el('span', { class: 'spinner' }),
              el('span', {
                text:
                  '  Смотрим, куда указывает ' + (state.answers.hostname || 'имя сервера') + '…',
              }),
            ]),
      );
    }
    step.fields.forEach(function (field) {
      if (!fieldVisible(field)) return;
      (field.advanced ? advanced : plain).push(renderField(field));
    });

    // Свой сертификат разбирается ДО установки: неподходящая пара ключа и
    // сертификата останавливает почту целиком, и узнавать об этом после
    // применения слишком поздно.
    if (step.id === 'tls' && state.answers.tls === 'custom') {
      plain.push(
        el('div', { class: 'field' }, [
          el('button', {
            class: 'btn--plain',
            text: state.certChecking ? 'Проверяем…' : 'Проверить сертификат',
            disabled:
              state.certChecking ||
              !String(state.answers.customCert || '').trim() ||
              !String(state.answers.customKey || '').trim()
                ? 'disabled'
                : null,
            onclick: checkCustomCert,
          }),
          state.certCheck
            ? el(
                'div',
                { style: 'margin-top:14px' },
                (state.certCheck.issues || []).map(function (issue) {
                  return checkRow({
                    id: issue.id,
                    title: issue.title,
                    status: issue.level,
                    detail: issue.detail,
                    hint: issue.hint,
                  });
                }),
              )
            : null,
          state.certCheck && !state.certCheck.ok
            ? el('div', {
                class: 'note note--fail',
                text: 'Пока это не исправлено, поставить такой сертификат нельзя.',
              })
            : null,
        ]),
      );
    }

    var body = plain;
    if (advanced.length) {
      var details = el('details', { class: 'adv' }, [
        el('summary', { text: 'Дополнительно — менять не нужно, если стенд один' }),
        el('p', {
          class: 'adv__note',
          text:
            'Эти значения нужны в одном случае: когда на машине уже что-то занято и надо ' +
            'развести два стенда. На обычном сервере оставьте как есть.',
        }),
      ]);
      advanced.forEach(function (node) {
        details.appendChild(node);
      });
      body = body.concat([details]);
    }

    // Со своим сертификатом дальше не пускаем, пока он не разобран и не
    // признан годным: «Далее» здесь означает «это и поставим».
    var needsCert = step.id === 'tls' && state.answers.tls === 'custom';
    return {
      body: body,
      before: null,
      extraAction: null,
      nextLabel: 'Далее',
      canNext: !needsCert || (state.certCheck !== null && state.certCheck.ok === true),
      title: step.title,
      intro: step.intro,
    };
  }

  function screenWizard() {
    var step = state.steps[state.stepIndex];
    var view = step.id === 'system' ? stepSystem(step) : stepFields(step);

    var actions = [];
    if (state.stepIndex > 0) {
      actions.push(
        el('button', {
          class: 'btn--plain',
          text: 'Назад',
          onclick: function () {
            state.stepIndex -= 1;
            render();
          },
        }),
      );
    }
    if (view.extraAction) actions.push(view.extraAction);
    actions.push(
      el('button', {
        class: 'btn--main',
        text: state.stepIndex === state.steps.length - 1 ? 'К сводке' : view.nextLabel,
        disabled: view.canNext && !state.busy ? null : 'disabled',
        onclick: goNext,
      }),
    );

    var card = el('section', { class: 'card' }, [
      el('h1', { text: view.title }),
      el('p', { class: 'intro', text: view.intro }),
      view.before,
    ]);
    view.body.forEach(function (node) {
      card.appendChild(node);
    });
    if (state.globalError) {
      card.appendChild(el('div', { class: 'note note--fail', text: state.globalError }));
    }
    card.appendChild(el('div', { class: 'actions' }, actions));

    return [rail(), card];
  }

  function goNext() {
    state.globalError = '';
    state.busy = true;
    render();
    api('/api/validate', { method: 'POST', body: state.answers }).then(function (res) {
      state.busy = false;
      var errors = (res.data && res.data.errors) || [];
      var stepFieldNames = {};
      state.steps[state.stepIndex].fields.forEach(function (field) {
        stepFieldNames[field.name] = true;
      });
      // Показываем ТОЛЬКО ошибки этого шага. Иначе, едва открыв «Домен»,
      // человек видел бы красным и адрес администратора, которого ещё не
      // спрашивали, — то есть претензию к тому, чего он не делал.
      state.errors = {};
      var blocking = 0;
      errors.forEach(function (error) {
        if (!stepFieldNames[error.field]) return;
        state.errors[error.field] = error.message;
        blocking += 1;
      });
      if (blocking > 0) {
        render();
        return;
      }
      if (state.stepIndex === state.steps.length - 1) {
        // Последний шаг пройден, но ошибки могли остаться на предыдущих —
        // тогда возвращаем туда, где они, а не запускаем установку.
        if (errors.length > 0) {
          var firstBad = errors[0].field;
          for (var i = 0; i < state.steps.length; i += 1) {
            var found = state.steps[i].fields.some(function (field) {
              return field.name === firstBad;
            });
            if (found) {
              state.stepIndex = i;
              var names = {};
              state.steps[i].fields.forEach(function (field) {
                names[field.name] = true;
              });
              errors.forEach(function (error) {
                if (names[error.field]) state.errors[error.field] = error.message;
              });
              break;
            }
          }
          render();
          return;
        }
        state.screen = 'review';
        render();
        return;
      }
      state.stepIndex += 1;
      if (state.steps[state.stepIndex].id === 'system' && state.checks === null) runChecks();
      // Домен подставляет заготовки в следующие поля — но только пустые:
      // то, что человек ввёл сам, трогать нельзя.
      suggestDefaults();
      render();
    });
  }

  function suggestDefaults() {
    var domain = (state.answers.domain || '').trim();
    if (!domain) return;
    if (!state.answers.hostname) state.answers.hostname = 'mail.' + domain;
    if (!state.answers.adminEmail) state.answers.adminEmail = 'admin@' + domain;
    if (!state.answers.adminLogin && state.answers.adminEmail) {
      state.answers.adminLogin = String(state.answers.adminEmail).split('@')[0];
    }
    if (!state.answers.leEmail && state.answers.adminEmail) {
      state.answers.leEmail = state.answers.adminEmail;
    }
  }

  // --- сводка ------------------------------------------------------

  function screenReview() {
    var a = state.answers;
    var rows = [
      row('Почтовый домен', a.domain),
      row('Имя сервера', a.hostname),
      row('Администратор', a.adminEmail + ' (логин в панели: ' + a.adminLogin + ')'),
      row(
        'Сертификат',
        a.tls === 'letsencrypt'
          ? 'Let’s Encrypt'
          : a.tls === 'custom'
            ? 'свой' +
              (state.certCheck && state.certCheck.certificate
                ? ' — ' +
                  state.certCheck.certificate.commonName +
                  ', кем выдан: ' +
                  state.certCheck.certificate.issuer
                : '')
            : 'самоподписанный',
      ),
      row('Антивирус ClamAV', a.clamav ? 'включён' : 'выключен'),
      row('Помощник ИИ', a.aiEnabled ? 'разрешён' : 'выключен'),
      row('Адрес публикации', a.bindAddress),
      row(
        'Порты почты',
        [a['port.smtp'], a['port.submission'], a['port.imaps']].join(', ') + ' и другие',
      ),
      row('Предел письма', Math.round(a.messageMaxBytes / 1048576) + ' МиБ'),
      row('Квота ящика', Math.round((a.defaultQuotaBytes / 1073741824) * 10) / 10 + ' ГиБ'),
    ];

    var warnings = [];
    if (state.looksConfigured) {
      var list = el('ul', {});
      state.traces.forEach(function (trace) {
        list.appendChild(el('li', { text: trace }));
      });
      warnings.push(
        el('div', { class: 'note note--warn' }, [
          el('div', {
            text:
              'На этом сервере уже что-то настроено, хотя отметки «установлено» нет. ' +
              'Установщик не станет делать это молча:',
          }),
          list,
          el('label', { class: 'toggle', style: 'margin-top:10px' }, [
            el('input', {
              type: 'checkbox',
              checked: state.confirmOverwrite ? 'checked' : null,
              onchange: function (event) {
                state.confirmOverwrite = event.target.checked;
                render();
              },
            }),
            el('span', {
              text: 'Я понимаю и хочу установить поверх. Копию я снял (install/backup.sh).',
            }),
          ]),
        ]),
      );
    }

    var card = el('section', { class: 'card' }, [
      el('h1', { text: 'Проверьте и запускайте' }),
      el('p', {
        class: 'intro',
        text:
          'Дальше работает та же install/install.sh, которой ставят из консоли: она запишет ' +
          'infra/.env, применит схему базы, поднимет стек, заведёт домен, ящик и учётную ' +
          'запись администратора. Первый запуск собирает образы — это 5–15 минут.',
      }),
    ]);
    warnings.forEach(function (node) {
      card.appendChild(node);
    });
    var table = el('table', { class: 'kv' }, rows);
    card.appendChild(table);
    if (state.globalError) {
      card.appendChild(el('div', { class: 'note note--fail', text: state.globalError }));
    }
    card.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn--plain',
          text: 'Назад',
          onclick: function () {
            state.screen = 'wizard';
            render();
          },
        }),
        el('button', {
          class: 'btn--main',
          text: state.busy ? 'Запускаем…' : 'Установить',
          disabled:
            state.busy || (state.looksConfigured && !state.confirmOverwrite) ? 'disabled' : null,
          onclick: startInstall,
        }),
      ]),
    );

    return [rail(), card];
  }

  function startInstall() {
    state.busy = true;
    state.globalError = '';
    render();
    var body = Object.assign({}, state.answers, { confirmOverwrite: state.confirmOverwrite });
    api('/api/install', { method: 'POST', body: body }).then(function (res) {
      state.busy = false;
      if (res.status !== 200) {
        if (res.data && res.data.needsConfirm) {
          state.looksConfigured = true;
          state.traces = res.data.traces || [];
        }
        state.globalError = res.data.message || 'Установка не запустилась.';
        if (res.data && res.data.errors && res.data.errors.length) {
          state.globalError = res.data.errors[0].message;
        }
        render();
        return;
      }
      state.screen = 'run';
      state.logLines = [];
      state.logFrom = 0;
      state.phase = 'running';
      render();
      poll();
    });
  }

  // --- ход установки -----------------------------------------------

  function poll() {
    api('/api/progress?from=' + state.logFrom).then(function (res) {
      if (res.status !== 200) {
        window.setTimeout(poll, 2000);
        return;
      }
      var data = res.data;
      state.logFrom = data.from;
      state.logLines = state.logLines.concat(data.lines);
      if (state.logLines.length > 4000) {
        state.logLines = state.logLines.slice(state.logLines.length - 4000);
      }
      state.phase = data.phase;
      state.failure = data.failure || '';
      render();
      if (data.phase === 'running') {
        window.setTimeout(poll, 1000);
      } else if (data.phase === 'done') {
        loadSummary();
      }
    });
  }

  function screenRun() {
    var logNode = el('div', { class: 'log', text: state.logLines.join('\n') });
    var head;
    if (state.phase === 'running') {
      head = el('p', { class: 'intro' }, [
        el('span', { class: 'spinner' }),
        el('span', { text: '  Идёт установка. Окно можно не закрывать — журнал ниже живой.' }),
      ]);
    } else if (state.phase === 'failed') {
      head = el('div', { class: 'note note--fail', text: state.failure });
    } else {
      head = el('p', { class: 'intro', text: 'Установка завершена, собираем итог…' });
    }

    var actions = [];
    if (state.phase === 'failed') {
      actions.push(
        el('button', {
          class: 'btn--plain',
          text: 'Вернуться к настройкам',
          onclick: function () {
            state.screen = 'wizard';
            state.stepIndex = 0;
            render();
          },
        }),
      );
      actions.push(
        el('button', {
          class: 'btn--main',
          text: 'Повторить установку',
          onclick: function () {
            state.screen = 'review';
            render();
          },
        }),
      );
    }

    var card = el('section', { class: 'card' }, [el('h1', { text: 'Установка' }), head, logNode]);
    if (actions.length) card.appendChild(el('div', { class: 'actions' }, actions));

    window.setTimeout(function () {
      logNode.scrollTop = logNode.scrollHeight;
    }, 0);
    return [rail(), card];
  }

  function loadSummary() {
    api('/api/summary').then(function (res) {
      if (res.status === 200) {
        state.summary = res.data.summary;
        state.mark = res.data.mark;
        state.screen = 'done';
      } else {
        state.globalError = res.data.message || '';
      }
      render();
    });
  }

  function screenDone() {
    var s = state.summary || {};
    var card = el('section', { class: 'card' }, [
      el('h1', { text: 'Готово' }),
      el('div', {
        class: 'note note--ok',
        text:
          'Почтовый сервер установлен и работает. Сервер отмечен как установленный — ' +
          'этот мастер на нём больше не откроется.',
      }),
      el('table', { class: 'kv' }, [
        row('Почта в браузере', s.webUrl || ''),
        row('Панель управления', s.adminUrl || ''),
        row('Ящик администратора', s.adminEmail || ''),
        row('Логин в панели', s.adminLogin || ''),
        row('Почтовый сервер', s.hostname || ''),
      ]),
      el('h2', { text: 'Что осталось сделать' }),
      el('p', {
        class: 'muted',
        text:
          '1. Опубликовать DNS-записи ниже. Пока они не разойдутся, ни почта, ни панель ' +
          'по своим именам не откроются, и чужие серверы не найдут, куда доставлять письма.',
      }),
      el('p', {
        class: 'muted',
        text:
          '2. Попросить хостера сделать обратную запись PTR на ' +
          (s.hostname || 'имя сервера') +
          '. Без неё Google, Mail.ru и Яндекс отбивают письма ещё на подключении.',
      }),
      el('p', {
        class: 'muted',
        text: '3. Проверить установку на сервере: sudo bash install/selfcheck.sh',
      }),
    ]);

    if (s.certTimerHint) {
      card.appendChild(
        el('div', { class: 'note note--warn' }, [
          el('div', {
            text:
              'Автопродление сертификата включается на самом сервере — установщик работает ' +
              'в контейнере, а таймер systemd живёт на хосте, и оттуда его завести нечем. ' +
              'Сертификат Let’s Encrypt живёт 90 дней; без продления почта в один день просто ' +
              'перестанет приниматься. Одна команда:',
          }),
          el('div', {
            class: 'dns',
            style: 'margin-top:8px',
            text: 'sudo bash install/renew-certs.sh --install-timer',
          }),
        ]),
      );
    }

    if (s.dnsRecords) {
      card.appendChild(el('h2', { text: 'DNS-записи' }));
      card.appendChild(
        el('p', {
          class: 'muted',
          text: 'Эти же записи сохранены на сервере: install/state/dns-records.txt',
        }),
      );
      card.appendChild(el('div', { class: 'dns', text: s.dnsRecords }));
    }

    card.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn--main',
          text: state.busy ? 'Останавливаем…' : 'Завершить и выключить установщик',
          disabled: state.busy ? 'disabled' : null,
          onclick: function () {
            state.busy = true;
            render();
            api('/api/finish', { method: 'POST', body: {} }).then(function () {
              window.sessionStorage.removeItem(KEY_STORAGE);
              state.screen = 'closed';
              state.busy = false;
              render();
            });
          },
        }),
      ]),
    );
    card.appendChild(
      el('p', {
        class: 'muted',
        text:
          'Нажав кнопку, вы остановите службу установщика вместе с её доступом к Docker. ' +
          'Дальше сервером управляют почта и панель по адресам выше.',
      }),
    );

    return [rail(), card];
  }

  function screenClosed() {
    return el('div', { class: 'card card--narrow' }, [
      el('h1', { text: 'Установщик выключен' }),
      el('p', {
        class: 'intro',
        text:
          'Служба остановлена, доступ к Docker вместе с ней исчез. Эту страницу можно закрыть: ' +
          'она больше не отвечает.',
      }),
      el('p', {
        class: 'muted',
        text:
          'Поднять установщик снова можно только с сервера, и на установленном сервере он ' +
          'откажется работать, пока отметку не снимут командой install/allow-reinstall.sh.',
      }),
    ]);
  }

  // ---------------------------------------------------------------
  // Отрисовка и запуск
  // ---------------------------------------------------------------

  function render() {
    var content;
    var single = true;
    switch (state.screen) {
      case 'blocked':
        content = [screenBlocked()];
        break;
      case 'key':
        content = [screenKey()];
        break;
      case 'wizard':
        content = screenWizard();
        single = false;
        break;
      case 'review':
        content = screenReview();
        single = false;
        break;
      case 'run':
        content = screenRun();
        single = false;
        break;
      case 'done':
        content = screenDone();
        single = false;
        break;
      case 'closed':
        content = [screenClosed()];
        break;
      default:
        content = [screenBoot()];
    }
    root.className = single ? 'shell shell--single' : 'shell';
    root.textContent = '';
    content.forEach(function (node) {
      root.appendChild(node);
    });
  }

  function loadContext() {
    api('/api/context').then(function (res) {
      if (res.status === 401) {
        state.key = '';
        window.sessionStorage.removeItem(KEY_STORAGE);
        state.keyError = res.data.message || '';
        state.screen = 'key';
        render();
        return;
      }
      state.steps = res.data.steps || [];
      state.defaults = res.data.defaults || {};
      state.answers = Object.assign({}, state.defaults, state.answers);
      state.traces = res.data.traces || [];
      state.looksConfigured = !!res.data.looksConfigured;
      state.screen = 'wizard';
      state.stepIndex = 0;
      render();
      runChecks();
    });
  }

  api('/api/state').then(function (res) {
    if (res.data.mode === 'installed' || res.data.mode === 'broken') {
      state.blocked = res.data;
      state.screen = 'blocked';
      render();
      return;
    }
    if (state.key) {
      loadContext();
    } else {
      state.screen = 'key';
      render();
    }
  });

  render();
})();
