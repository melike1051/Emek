import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/customer_api.dart';
import '../../api/provider_api.dart';
import '../../domain/booking_rules.dart';
import '../../domain/provider_rules.dart';
import '../../session/providers.dart';
import '../../widgets/common.dart';
import '../../widgets/error_view.dart';
import '../customer/customer_providers.dart';
import 'provider_providers.dart';

/// Basit komut durumu: meşgul + güvenli hata. Profil uçları idempotency anahtarı istemez
/// (backend kaynak başına tekildir: aynı hizmet/beceri iki kez eklenmez).
mixin _Busy<T extends ConsumerStatefulWidget> on ConsumerState<T> {
  bool busy = false;
  Object? error;

  Future<bool> run(Future<void> Function() action) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
      return true;
    } catch (caught) {
      if (mounted) setState(() => error = caught);
      return false;
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

/// `/panel/profil` — tanıtım, deneyim, günlük üst sınır (UpdateProviderProfileDto).
class ProviderProfileScreen extends ConsumerStatefulWidget {
  const ProviderProfileScreen({super.key});

  @override
  ConsumerState<ProviderProfileScreen> createState() =>
      _ProviderProfileScreenState();
}

class _ProviderProfileScreenState extends ConsumerState<ProviderProfileScreen>
    with _Busy {
  late final TextEditingController _name;
  late final TextEditingController _bio;
  late final TextEditingController _experience;
  late final TextEditingController _maxDaily;
  final _errors = <String, String>{};
  bool _saved = false;

  @override
  void initState() {
    super.initState();
    final p = ref.read(sessionProvider).value!.provider!;
    _name = TextEditingController(text: p.displayName);
    _bio = TextEditingController(text: p.bio ?? '');
    _experience = TextEditingController(
      text: p.experienceYears == null
          ? ''
          : '${p.experienceYears}'.replaceAll('.0', ''),
    );
    _maxDaily = TextEditingController(text: '${p.maxDailyBookings}');
  }

  @override
  void dispose() {
    for (final c in [_name, _bio, _experience, _maxDaily]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final experienceText = _experience.text.trim().replaceAll(',', '.');
    final experience = experienceText.isEmpty
        ? null
        : double.tryParse(experienceText);
    final maxDaily = int.tryParse(_maxDaily.text.trim());
    setState(() {
      _saved = false;
      _errors
        ..clear()
        ..addAll({
          if (name.length < 2 || name.length > 120)
            'displayName': 'Ad 2–120 karakter olmalı.',
          if (experienceText.isNotEmpty &&
              (experience == null || experience < 0 || experience > 80))
            'experienceYears': 'Deneyim 0–80 yıl arasında olmalı.',
          if (maxDaily == null || maxDaily < 1 || maxDaily > 10)
            'maxDailyBookings': 'Günlük üst sınır 1–10 arasında olmalı.',
        });
    });
    if (_errors.isNotEmpty) return;
    final ok = await run(
      () => ref.read(providerApiProvider).updateProfile({
        'displayName': name,
        'bio': _bio.text.trim(),
        'experienceYears': ?experience,
        'maxDailyBookings': maxDaily,
      }),
    );
    if (ok && mounted) {
      ref.invalidate(sessionProvider);
      setState(() => _saved = true);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Profil')),
    body: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        TextField(
          controller: _name,
          maxLength: 120,
          decoration: InputDecoration(
            labelText: 'Görünen adınız',
            errorText: _errors['displayName'],
          ),
        ),
        TextField(
          key: const Key('profile.bio'),
          controller: _bio,
          maxLength: 2000,
          maxLines: 5,
          decoration: const InputDecoration(labelText: 'Kendinizi tanıtın'),
        ),
        TextField(
          controller: _experience,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(
            labelText: 'Deneyim (yıl)',
            errorText: _errors['experienceYears'],
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _maxDaily,
          keyboardType: TextInputType.number,
          decoration: InputDecoration(
            labelText: 'Günde en fazla iş',
            errorText: _errors['maxDailyBookings'],
          ),
        ),
        const SizedBox(height: 16),
        if (error != null) ...[
          ErrorView(error: error!),
          const SizedBox(height: 12),
        ],
        if (_saved) const Notice('Profiliniz kaydedildi.'),
        BusyButton(label: 'Kaydet', busy: busy, onPressed: _save),
      ],
    ),
  );
}

/// `/panel/hizmetler` — sunulan hizmetler (dokun: ekle/kaldır) + beceriler.
class ProviderServicesScreen extends ConsumerStatefulWidget {
  const ProviderServicesScreen({super.key});

  @override
  ConsumerState<ProviderServicesScreen> createState() =>
      _ProviderServicesScreenState();
}

class _ProviderServicesScreenState extends ConsumerState<ProviderServicesScreen>
    with _Busy {
  String? _skillId;
  String _level = 'INTERMEDIATE';

  Future<void> _toggle(String serviceId, bool on) async {
    final api = ref.read(providerApiProvider);
    await run(
      () => on ? api.addService(serviceId) : api.removeService(serviceId),
    );
    invalidateReadiness(ref);
  }

  @override
  Widget build(BuildContext context) {
    final catalog = ref.watch(servicesProvider);
    final mine = ref.watch(myServicesProvider);
    final skillCatalog = ref.watch(skillCatalogProvider);
    final mySkills = ref.watch(mySkillsProvider);
    final active = {
      for (final s in mine.value ?? const <ProviderService>[])
        if (s.active) s.serviceId,
    };
    return Scaffold(
      appBar: AppBar(title: const Text('Hizmetler')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (error != null) ...[
            ErrorView(error: error!),
            const SizedBox(height: 12),
          ],
          SectionCard(
            title: 'Sunduğunuz hizmetler',
            children: [
              AsyncBody(
                value: catalog,
                onRetry: () => ref.invalidate(servicesProvider),
                data: (list) => Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final service in list)
                      FilterChip(
                        label: Text(service.name),
                        selected: active.contains(service.id),
                        onSelected: busy || !mine.hasValue
                            ? null
                            : (on) => _toggle(service.id, on),
                      ),
                  ],
                ),
              ),
            ],
          ),
          SectionCard(
            title: 'Becerileriniz',
            children: [
              for (final skill in mySkills.value ?? const <ProviderSkill>[])
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(skill.name),
                  subtitle: Text(
                    '${skillLevelLabels[skill.level] ?? skill.level}'
                    '${skill.verified ? ' · doğrulandı' : ' · doğrulama bekliyor'}',
                  ),
                  trailing: IconButton(
                    tooltip: '${skill.name} becerisini kaldır',
                    icon: const Icon(Icons.delete_outline),
                    onPressed: busy
                        ? null
                        : () async {
                            await run(
                              () => ref
                                  .read(providerApiProvider)
                                  .removeSkill(skill.skillId),
                            );
                            ref.invalidate(mySkillsProvider);
                          },
                  ),
                ),
              const Text(
                'Beceriler operasyon ekibi doğrulayınca eşleştirmede sayılır.',
              ),
              const SizedBox(height: 12),
              AsyncBody(
                value: skillCatalog,
                onRetry: () => ref.invalidate(skillCatalogProvider),
                data: (all) {
                  final owned = {
                    for (final s in mySkills.value ?? const <ProviderSkill>[])
                      s.skillId,
                  };
                  final available = all
                      .where((s) => !owned.contains(s.id))
                      .toList();
                  if (available.isEmpty) return const SizedBox.shrink();
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      DropdownButtonFormField<String>(
                        key: const Key('skills.skill'),
                        initialValue: available.any((s) => s.id == _skillId)
                            ? _skillId
                            : null,
                        isExpanded: true,
                        decoration: const InputDecoration(labelText: 'Beceri'),
                        items: [
                          for (final s in available)
                            DropdownMenuItem(value: s.id, child: Text(s.name)),
                        ],
                        onChanged: (id) => setState(() => _skillId = id),
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        initialValue: _level,
                        decoration: const InputDecoration(labelText: 'Seviye'),
                        items: [
                          for (final e in skillLevelLabels.entries)
                            DropdownMenuItem(
                              value: e.key,
                              child: Text(e.value),
                            ),
                        ],
                        onChanged: (v) => setState(() => _level = v ?? _level),
                      ),
                      const SizedBox(height: 12),
                      BusyButton(
                        label: 'Beceri ekle',
                        busy: busy,
                        onPressed: _skillId == null
                            ? null
                            : () async {
                                final ok = await run(
                                  () => ref
                                      .read(providerApiProvider)
                                      .addSkill(_skillId!, _level),
                                );
                                if (ok) setState(() => _skillId = null);
                                ref.invalidate(mySkillsProvider);
                              },
                      ),
                    ],
                  );
                },
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// `/panel/bolgeler` — hizmet bölgeleri (merkez + yarıçap). Merkez kayıtlı adresten, cihaz
/// konumundan ya da elle.
class ServiceAreasScreen extends ConsumerStatefulWidget {
  const ServiceAreasScreen({super.key});

  @override
  ConsumerState<ServiceAreasScreen> createState() => _ServiceAreasScreenState();
}

class _ServiceAreasScreenState extends ConsumerState<ServiceAreasScreen>
    with _Busy {
  final _name = TextEditingController();
  final _lat = TextEditingController();
  final _lon = TextEditingController();
  int _radiusKm = 5;
  final _errors = <String, String>{};

  @override
  void dispose() {
    for (final c in [_name, _lat, _lon]) {
      c.dispose();
    }
    super.dispose();
  }

  double? _coordinate(TextEditingController c, double limit) {
    final value = double.tryParse(c.text.trim().replaceAll(',', '.'));
    return value == null || value.abs() > limit ? null : value;
  }

  Future<void> _add() async {
    final name = _name.text.trim();
    final lat = _coordinate(_lat, 90);
    final lon = _coordinate(_lon, 180);
    setState(() {
      _errors
        ..clear()
        ..addAll({
          if (name.length < 2 || name.length > 80)
            'name': 'Ad 2–80 karakter olmalı.',
          if (lat == null) 'lat': 'Geçerli bir enlem girin.',
          if (lon == null) 'lon': 'Geçerli bir boylam girin.',
        });
    });
    if (_errors.isNotEmpty) return;
    final ok = await run(
      () => ref
          .read(providerApiProvider)
          .addArea(
            name: name,
            latitude: lat!,
            longitude: lon!,
            radiusMeters: _radiusKm * 1000,
          ),
    );
    if (ok) {
      _name.clear();
      _lat.clear();
      _lon.clear();
    }
    invalidateReadiness(ref);
  }

  @override
  Widget build(BuildContext context) {
    final areas = ref.watch(myAreasProvider);
    final addresses = ref.watch(addressesProvider).value ?? const <Address>[];
    return Scaffold(
      appBar: AppBar(title: const Text('Bölgeler')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionCard(
            title: 'Hizmet bölgeleriniz',
            children: [
              AsyncBody(
                value: areas,
                onRetry: () => ref.invalidate(myAreasProvider),
                data: (list) => Column(
                  children: [
                    if (list.isEmpty) const Text('Henüz bölge eklemediniz.'),
                    for (final area in list)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(area.name),
                        subtitle: Text(
                          'Yarıçap ${formatRadius(area.radiusMeters)}',
                        ),
                        trailing: IconButton(
                          tooltip: 'Bölgeyi kaldır',
                          icon: const Icon(Icons.delete_outline),
                          onPressed: busy
                              ? null
                              : () async {
                                  await run(
                                    () => ref
                                        .read(providerApiProvider)
                                        .removeArea(area.id),
                                  );
                                  invalidateReadiness(ref);
                                },
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
          SectionCard(
            title: 'Yeni bölge',
            children: [
              TextField(
                key: const Key('area.name'),
                controller: _name,
                maxLength: 80,
                decoration: InputDecoration(
                  labelText: 'Bölge adı',
                  errorText: _errors['name'],
                ),
              ),
              if (addresses.isNotEmpty)
                DropdownButtonFormField<Address>(
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'Kayıtlı adresten seç',
                  ),
                  items: [
                    for (final a in addresses)
                      DropdownMenuItem(
                        value: a,
                        child: Text(a.display, overflow: TextOverflow.ellipsis),
                      ),
                  ],
                  onChanged: (a) {
                    if (a == null) return;
                    _lat.text = '${a.latitude}';
                    _lon.text = '${a.longitude}';
                  },
                ),
              const SizedBox(height: 12),
              UseMyLocationButton(
                onLocated: (lat, lon) {
                  _lat.text = lat.toStringAsFixed(6);
                  _lon.text = lon.toStringAsFixed(6);
                },
              ),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('area.lat'),
                      controller: _lat,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                        signed: true,
                      ),
                      decoration: InputDecoration(
                        labelText: 'Enlem',
                        errorText: _errors['lat'],
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: TextField(
                      key: const Key('area.lon'),
                      controller: _lon,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                        signed: true,
                      ),
                      decoration: InputDecoration(
                        labelText: 'Boylam',
                        errorText: _errors['lon'],
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<int>(
                initialValue: _radiusKm,
                decoration: const InputDecoration(labelText: 'Yarıçap'),
                items: [
                  for (final km in radiusOptionsKm)
                    DropdownMenuItem(value: km, child: Text('$km km')),
                ],
                onChanged: (v) => setState(() => _radiusKm = v ?? _radiusKm),
              ),
              const SizedBox(height: 12),
              if (error != null) ...[
                ErrorView(error: error!),
                const SizedBox(height: 12),
              ],
              BusyButton(label: 'Bölgeyi ekle', busy: busy, onPressed: _add),
            ],
          ),
        ],
      ),
    );
  }
}

/// `/panel/musaitlik` — haftalık müsaitlik; saatler İstanbul saatiyle girilir.
class AvailabilityScreen extends ConsumerStatefulWidget {
  const AvailabilityScreen({super.key});

  @override
  ConsumerState<AvailabilityScreen> createState() => _AvailabilityScreenState();
}

class _AvailabilityScreenState extends ConsumerState<AvailabilityScreen>
    with _Busy {
  late DateTime _monday = weekStart(istanbulDay(DateTime.now()));

  Future<void> _add(DateTime day) async {
    final from = await showTimePicker(
      context: context,
      initialTime: const TimeOfDay(hour: 9, minute: 0),
      helpText: 'Başlangıç (İstanbul saati)',
    );
    if (from == null || !mounted) return;
    final to = await showTimePicker(
      context: context,
      initialTime: const TimeOfDay(hour: 17, minute: 0),
      helpText: 'Bitiş (İstanbul saati)',
    );
    if (to == null) return;
    final start = istanbulAt(day, from.hour, from.minute);
    final end = istanbulAt(day, to.hour, to.minute);
    if (!end.isAfter(start)) {
      _snack('Bitiş, başlangıçtan sonra olmalı.');
      return;
    }
    if (start.isBefore(DateTime.now())) {
      _snack('Geçmiş bir saat eklenemez.');
      return;
    }
    await run(() => ref.read(providerApiProvider).addAvailability(start, end));
    ref.invalidate(weekAvailabilityProvider(_monday));
    invalidateReadiness(ref);
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  Widget build(BuildContext context) {
    final week = ref.watch(weekAvailabilityProvider(_monday));
    final today = istanbulDay(DateTime.now());
    return Scaffold(
      appBar: AppBar(title: const Text('Müsaitlik')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              IconButton(
                tooltip: 'Önceki hafta',
                icon: const Icon(Icons.chevron_left),
                onPressed: () => setState(
                  () => _monday = _monday.subtract(const Duration(days: 7)),
                ),
              ),
              Expanded(
                child: Text(
                  '${formatCalendarDay(_monday)} haftası',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              IconButton(
                tooltip: 'Sonraki hafta',
                icon: const Icon(Icons.chevron_right),
                onPressed: () => setState(
                  () => _monday = _monday.add(const Duration(days: 7)),
                ),
              ),
            ],
          ),
          if (error != null) ...[
            ErrorView(error: error!),
            const SizedBox(height: 12),
          ],
          AsyncBody(
            value: week,
            onRetry: () => ref.invalidate(weekAvailabilityProvider(_monday)),
            data: (windows) => Column(
              children: [
                for (var i = 0; i < 7; i++)
                  _DayCard(
                    day: _monday.add(Duration(days: i)),
                    past: _monday.add(Duration(days: i)).isBefore(today),
                    windows:
                        windows
                            .where(
                              (w) =>
                                  istanbulDay(w.startsAt) ==
                                  _monday.add(Duration(days: i)),
                            )
                            .toList()
                          ..sort((a, b) => a.startsAt.compareTo(b.startsAt)),
                    busy: busy,
                    onAdd: _add,
                    onRemove: (w) async {
                      await run(
                        () => ref
                            .read(providerApiProvider)
                            .removeAvailability(w.id),
                      );
                      ref.invalidate(weekAvailabilityProvider(_monday));
                      invalidateReadiness(ref);
                    },
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _DayCard extends StatelessWidget {
  const _DayCard({
    required this.day,
    required this.past,
    required this.windows,
    required this.busy,
    required this.onAdd,
    required this.onRemove,
  });
  final DateTime day;
  final bool past;
  final List<AvailabilityWindow> windows;
  final bool busy;
  final ValueChanged<DateTime> onAdd;
  final ValueChanged<AvailabilityWindow> onRemove;

  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 8),
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  dayTitle(day),
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
              if (!past)
                TextButton(
                  onPressed: busy ? null : () => onAdd(day),
                  child: const Text('Saat ekle'),
                ),
            ],
          ),
          if (windows.isEmpty)
            const Text('Müsait değilsiniz.')
          else
            Wrap(
              spacing: 8,
              children: [
                for (final w in windows)
                  InputChip(
                    label: Text(
                      '${formatTime(w.startsAt)} – ${formatTime(w.endsAt)}',
                    ),
                    onDeleted: past || busy ? null : () => onRemove(w),
                    deleteButtonTooltipMessage:
                        '${formatTime(w.startsAt)} – ${formatTime(w.endsAt)} aralığını sil',
                  ),
              ],
            ),
        ],
      ),
    ),
  );
}
