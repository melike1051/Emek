import 'package:flutter/material.dart';

/// `packages/ui/src/tokens.css` ("Artisanal Trust & Local Labor") renkleri — web ile aynı dil.
/// Yazı tipleri şimdilik sistem yazı tipidir (fontlar paketlenmedi; bkz. R-108 notu, ADR-0025).
abstract final class EmekColors {
  static const primary = Color(0xFFA85C56);
  static const primaryStrong = Color(0xFF8A443F);
  static const action = Color(0xFF8C4A28);
  static const secondary = Color(0xFF5B6B4F);
  static const secondaryTint = Color(0xFFEDF2EB);
  static const background = Color(0xFFFAF6F1);
  static const surface = Color(0xFFFFFFFF);
  static const surfaceMuted = Color(0xFFF5EFEB);
  static const border = Color(0xFFE8DFD5);
  static const text = Color(0xFF2D231E);
  static const textMuted = Color(0xFF786A61);
  static const danger = Color(0xFFBA1A1A);
  static const dangerTint = Color(0xFFFFDAD6);
}

ThemeData buildEmekTheme() {
  final scheme =
      ColorScheme.fromSeed(
        seedColor: EmekColors.primary,
        primary: EmekColors.action,
        secondary: EmekColors.secondary,
        surface: EmekColors.surface,
        error: EmekColors.danger,
      ).copyWith(
        onSurface: EmekColors.text,
        onSurfaceVariant: EmekColors.textMuted,
      );

  const radius = BorderRadius.all(Radius.circular(12));
  return ThemeData(
    colorScheme: scheme,
    scaffoldBackgroundColor: EmekColors.background,
    appBarTheme: const AppBarTheme(
      backgroundColor: EmekColors.background,
      foregroundColor: EmekColors.text,
      elevation: 0,
      centerTitle: false,
    ),
    cardTheme: const CardThemeData(
      color: EmekColors.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: radius,
        side: BorderSide(color: EmekColors.border),
      ),
    ),
    inputDecorationTheme: const InputDecorationTheme(
      border: OutlineInputBorder(borderRadius: radius),
      enabledBorder: OutlineInputBorder(
        borderRadius: radius,
        borderSide: BorderSide(color: EmekColors.border),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: EmekColors.action,
        minimumSize: const Size.fromHeight(52),
        shape: const RoundedRectangleBorder(borderRadius: radius),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(48),
        shape: const RoundedRectangleBorder(borderRadius: radius),
      ),
    ),
  );
}
