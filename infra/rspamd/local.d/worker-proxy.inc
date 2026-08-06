# Milter-прокси для Postfix (порт 11332). Self-scan: проверка в самом прокси. milter = yes; timeout
= 120s; upstream "local" { default = yes; self_scan = yes; }
