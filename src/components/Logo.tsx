import React from "react";

interface LogoProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
}

export function Logo({ className, size = 24, ...props }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      {...props}
    >
      {/* Outer map pin frame */}
      <path
        d="M50 92C50 92 14 60 14 41C14 24.9837 28.3269 12 46 12C50 12 50 12 54 12C71.6731 12 86 24.9837 86 41C86 60 50 92 50 92Z"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      
      {/* Mountain Range */}
      <path
        d="M17 50C25 45 35 34 43 31L61 46L82 32C83 35.5 84 39 84 41.5"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M43 31L51 27L61 46"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Winding Road / Path (Filled S-curve tapering to mountains) */}
      <path
        d="M41 82C40 70 56 61 48 48C45 44 48 41 51 41C54 41 51 44 54 49C62 61 48 70 54 82H41Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default Logo;
