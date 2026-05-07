import { Stack } from 'expo-router';
import { palette } from '../../theme/colors';

export default function MainLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: palette.navy[900] },
      }}
    />
  );
}
