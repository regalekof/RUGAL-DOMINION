# Mobile Responsiveness Fixes

This file contains all the mobile responsiveness improvements for Rugal's Dominion.

## Files to Update:

### 1. components/site-header.tsx
- Make header responsive with proper mobile navigation
- Hide social icons on mobile
- Adjust profile picture and wallet button sizes
- Hide username button on mobile

### 2. app/page.tsx
- Fix hero section text sizes and spacing
- Make main container responsive
- Adjust icon sizes and text scaling

### 3. components/token-burn.tsx
- Improve grid layout for mobile
- Adjust token image sizes
- Fix padding and spacing

### 4. components/nft-burn.tsx
- Improve grid layout for mobile
- Adjust NFT image sizes
- Fix padding and spacing

### 5. app/absorb/page.tsx
- Make absorb page mobile-friendly
- Adjust button sizes and spacing

### 6. app/profile/page.tsx
- Make profile page mobile-responsive
- Adjust card layouts and text sizes

## Implementation Strategy:

1. **Responsive Breakpoints:**
   - Mobile: < 640px (sm)
   - Tablet: 640px - 768px (sm-md)
   - Desktop: 768px+ (md+)

2. **Key Changes:**
   - Grid layouts: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`
   - Image sizes: `w-16 h-16 sm:w-20 sm:h-20`
   - Text sizes: `text-lg sm:text-xl md:text-2xl`
   - Padding: `p-3 sm:p-4`
   - Spacing: `gap-3 sm:gap-4`

3. **Mobile-First Approach:**
   - Start with mobile sizes
   - Scale up for larger screens
   - Preserve desktop experience

## Benefits:
- Better mobile user experience
- No impact on desktop layout
- Consistent responsive design
- Improved usability on all devices
