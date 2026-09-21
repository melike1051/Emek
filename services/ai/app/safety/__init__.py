"""Güvenlik anomali modeli (Faz 8, ADR-0019).

Servis **öneri üretir, karar vermez**: çıktısı core'un risk toplamasına destekleyici
bir sinyal olarak girer ve tek başına ``WARNING`` tavanını aşamaz. Veritabanına
erişim yoktur; girdi core'un türettiği sinyallerdir, ham konum dizisi değil.
"""
