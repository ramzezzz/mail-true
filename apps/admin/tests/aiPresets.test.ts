/**
 * Куда подключается помощник и покидают ли письма периметр.
 *
 * Признак «модель внутри периметра» был галочкой, которую ставил
 * администратор, и не проверял ничего: он менял ТОЛЬКО текст, который
 * видит пользователь почты, — «письма не покидают периметр» против
 * «уйдёт за пределы вашего сервера». То есть можно было указать
 * api.openai.com, поставить галочку и сказать людям неправду ровно там,
 * где они решают, доверить письмо или нет.
 *
 * Здесь закреплено, что теперь ответ следует из адреса.
 */
import { describe, expect, it } from 'vitest';
import { AI_PRESETS, isInsidePerimeter } from '../src/lib/ai';

describe('модель внутри периметра или снаружи', () => {
  it('петля, частные сети и соседи по стеку — внутри', () => {
    for (const url of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:1234/v1',
      'http://host.docker.internal:11434/v1',
      'http://10.0.0.5:8000/v1',
      'http://192.168.1.40:11434/v1',
      'http://172.28.0.9:8080/v1',
      'http://ollama:11434/v1',
      'http://llm.internal/v1',
    ]) {
      expect(isInsidePerimeter(url), url).toBe(true);
    }
  });

  it('чужие сервисы — снаружи, что бы ни думал администратор', () => {
    for (const url of [
      'https://api.openai.com/v1',
      'https://api.anthropic.com/v1',
      'http://203.0.113.10:8000/v1',
      // Похоже на своё, но это чужой домен: обмануть проверку именем
      // «localhost.example.com» не выйдет.
      'https://localhost.example.com/v1',
      'https://172.15.0.1/v1',
      'https://172.32.0.1/v1',
    ]) {
      expect(isInsidePerimeter(url), url).toBe(false);
    }
  });

  it('пустой и негодный адрес периметром не считаются', () => {
    expect(isInsidePerimeter('')).toBe(false);
    expect(isInsidePerimeter('не адрес')).toBe(false);
  });
});

describe('готовые варианты подключения', () => {
  it('у каждого варианта сказано, уходят ли письма наружу', () => {
    expect(AI_PRESETS.length).toBeGreaterThanOrEqual(4);
    for (const preset of AI_PRESETS) {
      expect(preset.title.length, preset.id).toBeGreaterThan(3);
      expect(preset.hint.length, preset.id).toBeGreaterThan(20);
    }
  });

  it('признак «внутри периметра» у вариантов совпадает с их адресом', () => {
    for (const preset of AI_PRESETS) {
      if (preset.baseUrl === '') continue; // «другой совместимый» — адрес вводят сами
      expect(isInsidePerimeter(preset.baseUrl), preset.id).toBe(preset.local);
    }
  });

  it('внешние варианты требуют ключ, местные — нет', () => {
    for (const preset of AI_PRESETS) {
      if (preset.baseUrl === '') continue;
      expect(preset.needsKey, preset.id).toBe(!preset.local);
    }
  });
});
