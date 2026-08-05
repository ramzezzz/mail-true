/**
 * Маршрут /compose: письмо пишется не на отдельной странице, а в окне
 * поверх списка (как у mail.ru). Страница открывает окно и уводит
 * во «Входящие».
 */

import { useEffect, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import { useUiStore } from '../app/store';

export function ComposePage() {
  const openCompose = useUiStore((s) => s.openCompose);
  const opened = useRef(false);

  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      openCompose();
    }
  }, [openCompose]);

  return <Navigate to="/inbox/" replace />;
}
