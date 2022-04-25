#pragma once

#include <libecs-cpp/ecs.hpp>

class SKELETON_ : public ecs::Component
{
  public:
    SKELETON_(); 
    SKELETON_(nlohmann::json);
    nlohmann::json Export();
};
