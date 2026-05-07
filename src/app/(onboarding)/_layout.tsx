import { Stack } from 'expo-router';
import { palette } from '../../theme/colors';

export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: palette.navy[900] },
      }}
    />
  );
}
